/**
 * Xác thực đơn giản cho gọi API: khi server trả 401 (AUTH_REQUIRED), hiện modal nhập pass.
 * Pass lưu ở session (cookie); lần sau không cần nhập lại cho đến khi hết session.
 * Dùng apiFetch() thay cho fetch() cho mọi request tới /api/.
 */
(function () {
  var modal = null;
  var pending = null; // { resolve, reject, url, options }

  function getModal() {
    if (modal) return modal;
    var wrap = document.createElement('div');
    wrap.id = 'api-auth-overlay';
    wrap.innerHTML =
      '<div class="api-auth-backdrop"></div>' +
      '<div class="api-auth-box" role="dialog" aria-label="Xác thực">' +
      '<p class="api-auth-title">Xác thực</p>' +
      '<p class="api-auth-desc">Nhập mật khẩu để sử dụng chức năng gọi API.</p>' +
      '<input type="password" id="api-auth-password" class="api-auth-input" placeholder="Mật khẩu" autocomplete="current-password" />' +
      '<p id="api-auth-error" class="api-auth-error hidden"></p>' +
      '<button type="button" id="api-auth-submit" class="api-auth-btn">Xác nhận</button>' +
      '</div>';
    wrap.className = 'api-auth-overlay hidden';
    document.body.appendChild(wrap);
    modal = wrap;

    var style = document.createElement('style');
    style.textContent =
      '.api-auth-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}.api-auth-overlay.hidden{display:none!important}.api-auth-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.7)}.api-auth-box{position:relative;background:#1e293b;border:1px solid #475569;border-radius:12px;padding:24px;min-width:280px;max-width:360px}.api-auth-title{font-size:18px;font-weight:600;margin-bottom:8px;color:#f1f5f9}.api-auth-desc{font-size:14px;color:#94a3b8;margin-bottom:16px}.api-auth-input{width:100%;padding:10px 12px;border:1px solid #475569;border-radius:8px;background:#0f172a;color:#e2e8f0;font-size:14px;box-sizing:border-box}.api-auth-input:focus{outline:none;border-color:#38bdf8}.api-auth-error{color:#f87171;font-size:13px;margin-top:8px}.api-auth-error.hidden{display:none}.api-auth-btn{margin-top:16px;width:100%;padding:10px;background:#38bdf8;color:#0f172a;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px}.api-auth-btn:hover{background:#7dd3fc}';
    document.head.appendChild(style);

    var input = wrap.querySelector('#api-auth-password');
    var errEl = wrap.querySelector('#api-auth-error');
    var btn = wrap.querySelector('#api-auth-submit');

    function hideError() {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }

    function showError(msg) {
      errEl.textContent = msg || 'Mật khẩu không đúng';
      errEl.classList.remove('hidden');
    }

    btn.addEventListener('click', function () {
      var password = (input && input.value) || '';
      hideError();
      if (!password.trim()) {
        showError('Vui lòng nhập mật khẩu.');
        return;
      }
      btn.disabled = true;
      fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: password })
      })
        .then(function (res) {
          if (res.ok) {
            wrap.classList.add('hidden');
            input.value = '';
            if (pending) {
              var p = pending;
              pending = null;
              window.apiFetch(p.url, p.options).then(p.resolve).catch(p.reject);
            }
          } else {
            showError('Mật khẩu không đúng.');
          }
        })
        .catch(function () {
          showError('Lỗi kết nối.');
        })
        .finally(function () {
          btn.disabled = false;
        });
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') btn.click();
    });

    return wrap;
  }

  function showAuthModal() {
    var el = getModal();
    el.classList.remove('hidden');
    el.querySelector('#api-auth-error').classList.add('hidden');
    var input = el.querySelector('#api-auth-password');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  /**
   * Gọi API với credentials. Nếu trả 401 (từ bất kỳ API nào) thì hiện modal;
   * sau khi user nhập đúng pass, tự retry request và trả về response đó.
   */
  window.apiFetch = function (url, options) {
    options = options || {};
    options.credentials = options.credentials || 'include';
    return fetch(url, options).then(function (response) {
      if (response.status !== 401) return response;
      // Bất kỳ 401 nào từ /api/ (kể cả body không phải JSON) đều hiện modal
      var isApi = typeof url === 'string' && (url.indexOf('/api/') === 0 || url.indexOf('/api/') !== -1);
      if (isApi) {
        return new Promise(function (resolve, reject) {
          pending = { resolve: resolve, reject: reject, url: url, options: options };
          showAuthModal();
        });
      }
      return response;
    });
  };

  function runAuthCheck() {
    if (!document.body) return;
    fetch('/api/auth/check', { credentials: 'include' })
      .then(function (res) {
        if (res.status === 401) showAuthModal();
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAuthCheck);
  } else {
    runAuthCheck();
  }
})();
