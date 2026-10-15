/*!
 * Merchantflo checkout.js v1 — drop-in checkout for a Merchantflo checkout session.
 *
 *   <div id="pay"></div>
 *   <script src="https://<your-merchantflo-host>/checkout/v1/checkout.js"></script>
 *   <script>
 *     Merchantflo.mount(document.getElementById('pay'), {
 *       sessionId: 'cks_…',            // from POST /v1/checkout/sessions (your server)
 *       token: '…',                    // that response's clientToken
 *       apiBase: 'https://<your-merchantflo-host>',
 *       onComplete: (r) => { … },      // { status: 'success' | 'failed', paymentId }
 *     });
 *   </script>
 *
 * Renders inside a shadow root (no style clashes with your page), talks only to Merchantflo's
 * public checkout endpoints, never sees card data (cards open the PSP's own checkout), and tells
 * the customer not to pay again while a payment is being verified.
 */
(function () {
  'use strict';

  var STYLE = [
    ':host{all:initial;display:block;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#16191f}',
    '.mf{--bg:#fff;--fg:#16191f;--mut:#5b6472;--line:#e2e5ea;--acc:#2f5bd3;--acc-fg:#fff;--good:#1f7a4d;--good-bg:#e6f4ec;--warn-bg:#fdf3dc;--bad:#b3261e;',
    'background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:18px;max-width:440px;box-sizing:border-box}',
    '@media (prefers-color-scheme:dark){.mf{--bg:#171b21;--fg:#e8ebf0;--mut:#9aa3b2;--line:#2b313b;--acc:#7b9cff;--acc-fg:#0d1220;--good:#6fd3a0;--good-bg:#133324;--warn-bg:#3a2c0d;--bad:#ff8a80}}',
    '.amt{font-size:24px;font-weight:650;margin:0 0 2px}.sub{color:var(--mut);font-size:13px;margin:0 0 14px}',
    '.m{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer}',
    '.m[aria-pressed="true"]{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}.m:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}',
    '.m .n{flex:1;font-weight:600}.m .p{font-variant-numeric:tabular-nums}.tag{font-size:12px;font-weight:600;color:var(--good);background:var(--good-bg);border-radius:999px;padding:2px 8px}',
    '.btn{display:block;width:100%;box-sizing:border-box;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:650;cursor:pointer;text-align:center;text-decoration:none;background:var(--acc);color:var(--acc-fg);margin-top:10px}',
    '.btn.sec{background:transparent;color:var(--acc);border:1px solid var(--line)}.btn[disabled]{opacity:.6;cursor:default}',
    '.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.row .btn{flex:1;min-width:120px;margin-top:0}',
    'input{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;background:transparent;color:inherit;margin-top:6px}',
    '.note{background:var(--warn-bg);border-radius:8px;padding:10px;margin-top:12px;font-size:14px}.ok{background:var(--good-bg);color:var(--good);border-radius:8px;padding:12px;font-weight:600}',
    '.err{color:var(--bad);font-size:14px;margin-top:8px}.qr{display:block;width:220px;height:220px;margin:12px auto;background:#fff;border-radius:8px;padding:6px}',
    '.mut{color:var(--mut);font-size:13px}.flows{display:flex;gap:6px;margin:4px 0 8px}.flows button{flex:1}',
  ].join('');

  var LABELS = { UPI: 'UPI', NETBANKING: 'Netbanking', CARD: 'Debit / credit card', RUPAY_DEBIT: 'RuPay debit card' };
  var FLOW_LABELS = { INTENT: 'UPI app', QR: 'Scan QR', COLLECT: 'UPI ID' };

  function rupees(paise) {
    return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(s);
    });
  }

  function mount(host, opts) {
    if (!host || !opts || !opts.sessionId || !opts.token) throw new Error('Merchantflo.mount(element, { sessionId, token, apiBase })');
    var base = (opts.apiBase || '').replace(/\/$/, '') + '/public/checkout/sessions/' + encodeURIComponent(opts.sessionId);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var state = { view: null, method: null, flow: isMobile() ? 'INTENT' : 'QR', timer: null, done: false };

    function api(path, body) {
      return fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: Object.assign({ 'x-checkout-token': opts.token }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Request failed');
          return j;
        });
      });
    }

    function render(inner) {
      root.innerHTML = '<style>' + STYLE + '</style><div class="mf" role="region" aria-label="Payment"><div aria-live="polite">' + inner + '</div></div>';
    }

    function header() {
      var v = state.view;
      return '<p class="amt">' + rupees(v.amountPaise) + '</p><p class="sub">' + (v.orderId ? 'Order ' + esc(v.orderId) : 'Secure payment') + '</p>';
    }

    function showMethods(error) {
      var v = state.view;
      var m = state.method || v.methods[0].method;
      state.method = m;
      var html = header();
      v.methods.forEach(function (o) {
        var save = o.discountPaise > 0 ? '<span class="tag">Save ' + rupees(o.discountPaise) + '</span>' : '';
        html +=
          '<button type="button" class="m" data-m="' + o.method + '" aria-pressed="' + (o.method === m) + '"><span class="n">' + esc(LABELS[o.method] || o.method) + '</span>' + save +
          '<span class="p">' + rupees(o.payablePaise) + '</span></button>';
      });
      var sel = v.methods.filter(function (o) { return o.method === m; })[0];
      if (m === 'UPI' && sel.upiFlows && sel.upiFlows.length > 1) {
        if (sel.upiFlows.indexOf(state.flow) < 0) state.flow = sel.upiFlows[0];
        html += '<div class="flows" role="group" aria-label="How to pay with UPI">';
        sel.upiFlows.forEach(function (f) {
          html += '<button type="button" class="btn sec" data-f="' + f + '" aria-pressed="' + (f === state.flow) + '">' + FLOW_LABELS[f] + '</button>';
        });
        html += '</div>';
        if (state.flow === 'COLLECT') html += '<label class="mut">Your UPI ID<input id="vpa" autocomplete="off" placeholder="name@bank" /></label>';
      }
      html += '<button type="button" class="btn" id="pay">Pay ' + rupees(sel.payablePaise) + '</button>';
      if (error) html += '<p class="err" role="alert">' + esc(error) + '</p>';
      render(html);
      root.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.method = b.getAttribute('data-m');
          showMethods();
        });
      });
      root.querySelectorAll('[data-f]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.flow = b.getAttribute('data-f');
          showMethods();
        });
      });
      root.getElementById ? null : null;
      var payBtn = root.querySelector('#pay');
      payBtn.addEventListener('click', function () {
        payBtn.disabled = true;
        var body = { method: state.method };
        if (state.method === 'UPI') {
          body.upiFlow = state.flow;
          var vpaInput = root.querySelector('#vpa');
          if (state.flow === 'COLLECT') body.vpa = vpaInput ? vpaInput.value.trim() : '';
        }
        api('/pay', body)
          .then(function (r) {
            act(r.payment);
          })
          .catch(function (e) {
            showMethods(e.message);
          });
      });
    }

    function waiting(p, extra) {
      render(header() + extra + '<p class="mut">' + esc(p.message) + '</p>');
      poll();
    }

    function act(p) {
      if (!p) return refresh();
      if (p.status !== 'processing' || !p.action) return showStatus(p);
      var a = p.action;
      if (a.type === 'UPI_INTENT') {
        var apps = Object.keys(a.appUrls || {}).map(function (k) {
          return '<a class="btn sec" href="' + esc(a.appUrls[k]) + '">' + esc(k) + '</a>';
        });
        waiting(p, '<a class="btn" href="' + esc(a.url) + '">Open UPI app</a>' + (apps.length ? '<div class="row">' + apps.join('') + '</div>' : '') + '<p class="mut">Approve the payment in your UPI app, then come back here.</p>');
      } else if (a.type === 'UPI_QR') {
        var src = a.qrImage || base + '/qr.svg?token=' + encodeURIComponent(opts.token);
        waiting(p, '<img class="qr" alt="UPI QR code for ' + rupees(p.amountPaise) + '" src="' + esc(src) + '" /><p class="mut">Scan with any UPI app.</p>');
      } else if (a.type === 'UPI_COLLECT') {
        waiting(p, '<div class="note">A payment request was sent to <strong>' + esc(a.vpa) + '</strong>. Approve it in your UPI app.</div>');
      } else if (a.type === 'REDIRECT') {
        waiting(p, '<p>Taking you to your bank…</p>');
        window.location.assign(a.url);
      } else if (a.type === 'PSP_CHECKOUT') {
        waiting(p, '<p>Opening secure payment…</p>');
        openPsp(a).catch(function (e) {
          showMethods(e.message);
        });
      } else {
        waiting(p, '');
      }
    }

    function openPsp(a) {
      if (a.provider === 'cashfree') {
        return loadScript('https://sdk.cashfree.com/js/v3/cashfree.js').then(function () {
          /* global Cashfree */
          return Cashfree({ mode: a.environment === 'production' ? 'production' : 'sandbox' }).checkout({ paymentSessionId: a.params.paymentSessionId, redirectTarget: '_modal' });
        });
      }
      if (a.provider === 'razorpay') {
        return loadScript('https://checkout.razorpay.com/v1/checkout.js').then(function () {
          /* global Razorpay */
          new Razorpay({ key: a.params.keyId, order_id: a.params.orderId, handler: function () { poll(true); } }).open();
        });
      }
      // Test mode: a simulated PSP — the payment completes on its own.
      return Promise.resolve();
    }

    function showStatus(p) {
      if (p.status === 'success') {
        state.done = true;
        render(header() + '<div class="ok">Payment successful</div>');
        if (opts.onComplete) opts.onComplete({ status: 'success', paymentId: p.id });
        if (state.view.returnUrl) setTimeout(function () { window.location.assign(state.view.returnUrl); }, 1500);
        return;
      }
      if (p.status === 'failed') {
        if (opts.onComplete) opts.onComplete({ status: 'failed', paymentId: p.id });
        return showMethods(p.message + ' You can try again.');
      }
      if (p.status === 'refunded' || p.status === 'refund_processing') {
        state.done = true;
        render(header() + '<div class="note">' + esc(p.message) + '</div>');
        return;
      }
      // processing / verification_in_progress: never invite a second payment.
      render(header() + '<div class="note"><strong>Please don’t pay again.</strong> ' + esc(p.message) + '</div>');
      poll();
    }

    function poll(now) {
      if (state.timer || state.done) return;
      state.timer = setTimeout(function () {
        state.timer = null;
        api('/status')
          .then(function (s) {
            if (!s.payment) return;
            if (s.payment.status === 'processing' && s.payment.action) return poll();
            showStatus(s.payment);
          })
          .catch(function () {
            poll();
          });
      }, now ? 0 : 3000);
    }

    function refresh() {
      return api('')
        .then(function (v) {
          state.view = v;
          if (v.status === 'PAID') return showStatus({ status: 'success', id: v.payment && v.payment.id });
          if (v.status === 'EXPIRED') return render(header() + '<div class="note">This checkout has expired. Please start again.</div>');
          if (v.payment && (v.payment.status === 'processing' || v.payment.status === 'verification_in_progress')) return act(v.payment);
          showMethods();
        })
        .catch(function (e) {
          render('<p class="err" role="alert">' + esc(e.message) + '</p>');
        });
    }

    render('<p class="mut">Loading…</p>');
    refresh();
    return {
      destroy: function () {
        state.done = true;
        clearTimeout(state.timer);
        root.innerHTML = '';
      },
    };
  }

  window.Merchantflo = { mount: mount, version: '1' };
})();
