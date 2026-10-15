// Mounts the widget for ?session=…&token=… (both from POST /v1/checkout/sessions on your server).
(function () {
  'use strict';
  var q = new URLSearchParams(window.location.search);
  var session = q.get('session');
  var token = q.get('token');
  if (!session || !token) {
    var curl = document.getElementById('curl');
    curl.textContent =
      'curl -s ' + window.location.origin + '/v1/checkout/sessions \\n' +
      '  -H "authorization: Bearer sk_test_…" -H "content-type: application/json" \\n' +
      "  -d '{\"amountPaise\": 249900, \"orderId\": \"DEMO-1\"}'";
    curl.hidden = false;
    return;
  }
  document.getElementById('help').hidden = true;
  window.Merchantflo.mount(document.getElementById('pay'), {
    sessionId: session,
    token: token,
    onComplete: function (r) {
      document.getElementById('result').textContent = 'onComplete: ' + r.status + (r.paymentId ? ' (' + r.paymentId + ')' : '');
    },
  });
})();
