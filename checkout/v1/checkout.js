/*!
 * Merchantflo checkout.js v1 — drop-in checkout for a Merchantflo checkout session.
 *
 *   <div id="pay"></div>
 *   <script src="https://<your-merchantflo-host>/checkout/v1/checkout.js"></script>
 *   <script>
 *     Merchantflo.mount(document.getElementById('pay'), {
 *       sessionId: 'cks_…',            // from POST /v1/checkout/sessions (your server)
 *       token: '…',                    // that response's clientToken
 *       apiBase: 'https://<your-merchantflo-host>',   // default: where this script was loaded from
 *       onComplete: (r) => { … },      // { status: 'success' | 'failed', paymentId }
 *     });
 *   </script>
 *
 * Renders inside a shadow root (no style clashes with your page; styles come from checkout.css next
 * to this file, so a strict style-src CSP on your page needs only that origin), talks only to
 * Merchantflo's public checkout endpoints, never sees card data (cards open the PSP's own checkout),
 * and tells the customer not to pay again while a payment is being verified.
 */
(function () {
  'use strict';

  var script = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var ASSET_BASE = script ? script.replace(/[^/]*$/, '') : null;
  var ORIGIN = script ? new URL(script).origin : '';

  var LABELS = { UPI: 'UPI', NETBANKING: 'Netbanking', CARD: 'Debit / credit card', RUPAY_DEBIT: 'RuPay debit card' };
  var FLOW_LABELS = { INTENT: 'UPI app', QR: 'Scan QR', COLLECT: 'UPI ID' };
  // Payment links come from the PSP; only these schemes may reach an href or window.location.
  var SAFE_URL = /^(?:upi|tez|phonepe|paytmmp|paytm|gpay|bhim|credpay|intent):|^https:\/\//i;

  function safeUrl(u) {
    return typeof u === 'string' && SAFE_URL.test(u) ? u : null;
  }
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
        reject(new Error('Could not open the payment window. Please try again.'));
      };
      document.head.appendChild(s);
    });
  }

  function mount(host, opts) {
    if (!host || !opts || !opts.sessionId || !opts.token) throw new Error('Merchantflo.mount(element, { sessionId, token, apiBase })');
    var apiBase = (opts.apiBase || ORIGIN).replace(/\/$/, '');
    var base = apiBase + '/public/checkout/sessions/' + encodeURIComponent(opts.sessionId);
    var root = host.shadowRoot || (host.attachShadow ? host.attachShadow({ mode: 'open' }) : host);
    var state = { view: null, method: null, flow: isMobile() ? 'INTENT' : 'QR', timer: null, done: false, destroyed: false };

    // Stylesheet + container, built once; render() only swaps the container's content.
    root.innerHTML = '';
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = (ASSET_BASE || apiBase + '/checkout/v1/') + 'checkout.css';
    var box = document.createElement('div');
    box.className = 'mf';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Payment');
    box.hidden = true; // until styled, so the customer never sees an unstyled flash
    link.onload = link.onerror = function () {
      box.hidden = false;
    };
    var live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    box.appendChild(live);
    root.appendChild(link);
    root.appendChild(box);

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
      if (state.destroyed) return;
      live.innerHTML = inner;
    }

    function header() {
      var v = state.view;
      return '<p class="amt">' + rupees(v.amountPaise) + '</p><p class="sub">' + (v.orderId ? 'Order ' + esc(v.orderId) : 'Secure payment') + '</p>';
    }

    function showMethods(error) {
      var v = state.view;
      if (!v.methods.length) return render(header() + '<p class="err" role="alert">No payment method is available right now.</p>');
      var sel = v.methods.filter(function (o) { return o.method === state.method; })[0] || v.methods[0];
      state.method = sel.method;
      var html = header();
      v.methods.forEach(function (o) {
        var save = o.discountPaise > 0 ? '<span class="tag">Save ' + rupees(o.discountPaise) + '</span>' : '';
        html +=
          '<button type="button" class="m" data-m="' + esc(o.method) + '" aria-pressed="' + (o.method === sel.method) + '"><span class="n">' +
          esc(LABELS[o.method] || o.method) + '</span>' + save + '<span class="p">' + rupees(o.payablePaise) + '</span></button>';
      });
      if (sel.method === 'UPI' && sel.upiFlows && sel.upiFlows.length) {
        if (sel.upiFlows.indexOf(state.flow) < 0) state.flow = sel.upiFlows[0];
        if (sel.upiFlows.length > 1) {
          html += '<div class="flows" role="group" aria-label="How to pay with UPI">';
          sel.upiFlows.forEach(function (f) {
            html += '<button type="button" class="btn sec" data-f="' + esc(f) + '" aria-pressed="' + (f === state.flow) + '">' + esc(FLOW_LABELS[f] || f) + '</button>';
          });
          html += '</div>';
        }
        if (state.flow === 'COLLECT') html += '<label class="mut">Your UPI ID<input id="vpa" autocomplete="off" inputmode="email" placeholder="name@bank" /></label>';
      }
      html += '<button type="button" class="btn" id="pay">Pay ' + rupees(sel.payablePaise) + '</button>';
      if (error) html += '<p class="err" role="alert">' + esc(error) + '</p>';
      render(html);
      live.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.method = b.getAttribute('data-m');
          showMethods();
        });
      });
      live.querySelectorAll('[data-f]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.flow = b.getAttribute('data-f');
          showMethods();
        });
      });
      var payBtn = live.querySelector('#pay');
      payBtn.addEventListener('click', function () {
        payBtn.disabled = true;
        var body = { method: state.method };
        if (state.method === 'UPI') {
          body.upiFlow = state.flow;
          if (state.flow === 'COLLECT') {
            var vpaInput = live.querySelector('#vpa');
            body.vpa = vpaInput ? vpaInput.value.trim() : '';
            // Same rule as the API's, worded for the customer.
            if (!/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(body.vpa)) return showMethods('Enter your UPI ID, like name@bank.');
          }
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
        var url = safeUrl(a.url);
        var apps = Object.keys(a.appUrls || {})
          .filter(function (k) { return safeUrl(a.appUrls[k]); })
          .map(function (k) {
            return '<a class="btn sec" href="' + esc(a.appUrls[k]) + '">' + esc(k) + '</a>';
          });
        waiting(
          p,
          (url ? '<a class="btn" href="' + esc(url) + '">Open UPI app</a>' : '') + (apps.length ? '<div class="row">' + apps.join('') + '</div>' : '') +
            '<p class="mut">Approve the payment in your UPI app, then come back here.</p>',
        );
      } else if (a.type === 'UPI_QR') {
        var src = a.qrImage ? (/^data:image\/(png|jpeg|gif);base64,/.test(a.qrImage) ? a.qrImage : 'data:image/png;base64,' + a.qrImage) : base + '/qr.svg?token=' + encodeURIComponent(opts.token);
        waiting(p, '<img class="qr" alt="UPI QR code for ' + rupees(p.amountPaise) + '" src="' + esc(src) + '" /><p class="mut">Scan with any UPI app.</p>');
      } else if (a.type === 'UPI_COLLECT') {
        waiting(p, '<div class="note">A payment request was sent to <strong>' + esc(a.vpa) + '</strong>. Approve it in your UPI app.</div>');
      } else if (a.type === 'REDIRECT' && safeUrl(a.url)) {
        waiting(p, '<p>Taking you to your bank…</p>');
        window.location.assign(safeUrl(a.url));
      } else if (a.type === 'PSP_CHECKOUT') {
        waiting(p, '<p>Opening secure payment…</p>');
        openPsp(a).catch(function (e) {
          render(header() + '<p class="err" role="alert">' + esc(e.message) + '</p>');
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
        var ret = safeUrl(state.view.returnUrl);
        if (ret && !state.destroyed) setTimeout(function () { window.location.assign(ret); }, 1500);
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
      if (state.done || state.destroyed) return;
      if (state.timer) {
        if (!now) return;
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(function () {
        state.timer = null;
        api('/status')
          .then(function (s) {
            if (state.done || state.destroyed) return;
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
        state.destroyed = true;
        clearTimeout(state.timer);
        root.innerHTML = '';
      },
    };
  }

  window.Merchantflo = { mount: mount, safeUrl: safeUrl, version: '1' };
})();
