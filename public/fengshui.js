// Phong thủy hướng nhà – dùng ChatGPT (API), không tính Bát trạch thủ công
// DEBUG: mở DevTools (F12) > Console để xem log khi bấm "Xem hướng (ChatGPT)"

(function () {
  var onCalc;
  window.fengshuiCalc = function () { if (typeof onCalc === 'function') onCalc(); };
  console.log('[Fengshui] script loaded, fengshuiCalc=', typeof window.fengshuiCalc);

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str != null ? String(str) : '';
    return div.innerHTML;
  }

  function showError(msg) {
    var err = el('error');
    if (err) err.textContent = msg || '';
  }

  function clearError() {
    showError('');
  }

  function setLoading(loading) {
    var area = el('result-area');
    var btn = el('btn-calc');
    if (!area || !btn) return;
    if (loading) {
      area.innerHTML = '<div class="muted">Đang phân tích…</div>';
      btn.disabled = true;
    } else {
      btn.disabled = false;
    }
  }

  function renderResult(data) {
    var area = el('result-area');
    if (!area) return;

    var summary = data.summary || '';
    var directions = Array.isArray(data.directions) ? data.directions : [];
    var recommendation = data.recommendation || '';
    var husbandNote = data.husbandNote || '';
    var wifeNote = data.wifeNote || '';

    function ratingClass(r) {
      var s = (r || '').toLowerCase();
      if (s.indexOf('rất tốt') !== -1) return 'good-strong';
      if (s.indexOf('tốt') !== -1) return 'good';
      if (s.indexOf('trung tính') !== -1) return '';
      if (s.indexOf('rất xấu') !== -1) return 'bad-strong';
      if (s.indexOf('xấu') !== -1) return 'bad';
      return '';
    }

    var html = '';
    if (summary) {
      html += '<div class="summary" style="margin-bottom:12px">' + escapeHtml(summary) + '</div>';
    }
    if (husbandNote || wifeNote) {
      html += '<div class="muted" style="margin-bottom:12px">';
      if (husbandNote) html += '<div>Chồng: ' + escapeHtml(husbandNote) + '</div>';
      if (wifeNote) html += '<div>Vợ: ' + escapeHtml(wifeNote) + '</div>';
      html += '</div>';
    }
    if (directions.length > 0) {
      html += '<div class="table-wrap"><table class="tbl"><thead><tr><th>Hướng</th><th>Đánh giá</th><th>Ý nghĩa</th></tr></thead><tbody>';
      for (var i = 0; i < directions.length; i++) {
        var d = directions[i];
        var dir = d.direction || d.name || '—';
        var rating = d.rating || '—';
        var meaning = d.meaning || '—';
        var cls = ratingClass(rating);
        html += '<tr><td>' + escapeHtml(dir) + '</td><td class="' + (cls || '') + '">' + escapeHtml(rating) + '</td><td class="muted">' + escapeHtml(meaning) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    if (recommendation) {
      html += '<div class="summary" style="margin-top:14px">' + escapeHtml(recommendation) + '</div>';
    }
    if (!html) {
      html = '<div class="muted">Không có nội dung kết quả.</div>';
    }
    area.innerHTML = html;
  }

  function resetPlaceholder() {
    var area = el('result-area');
    if (area) area.innerHTML = '<div class="muted">Nhập thông tin và bấm "Xem hướng" để nhận đánh giá từ ChatGPT.</div>';
  }

  onCalc = function () {
    console.log('[Fengshui] onCalc() called');
    var husbandEl = el('husband-name');
    var wifeEl = el('wife-name');
    var husbandName = husbandEl ? (husbandEl.value || '').trim() : '';
    var wifeName = wifeEl ? (wifeEl.value || '').trim() : '';
    var husbandDob = (el('husband-dob') && el('husband-dob').value) ? el('husband-dob').value.trim() : '';
    var wifeDob = (el('wife-dob') && el('wife-dob').value) ? el('wife-dob').value.trim() : '';
    console.log('[Fengshui] form values:', { husbandName: husbandName, wifeName: wifeName, husbandDob: husbandDob, wifeDob: wifeDob });

    clearError();
    if (!husbandName || !wifeName) {
      console.log('[Fengshui] validation failed: thiếu họ tên');
      showError('Vui lòng nhập đủ họ tên chồng và vợ.');
      return;
    }

    console.log('[Fengshui] gửi request POST /api/fengshui');
    setLoading(true);
    var url = '/api/fengshui';
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        husbandName: husbandName,
        husbandDob: husbandDob || undefined,
        wifeName: wifeName,
        wifeDob: wifeDob || undefined
      })
    };

    var fetchFn = window.apiFetch || fetch;
    console.log('[Fengshui] dùng', window.apiFetch ? 'apiFetch' : 'fetch');
    fetchFn(url, options)
      .then(function (res) {
        console.log('[Fengshui] response status:', res.status, res.url);
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (_) { }
          return { status: res.status, body: body };
        });
      })
      .then(function (result) {
        console.log('[Fengshui] result:', result.status, result.body);
        setLoading(false);
        if (result.status !== 200) {
          showError(result.body && result.body.error ? result.body.error : 'Lỗi kết nối.');
          resetPlaceholder();
          return;
        }
        if (result.body && result.body.ok && result.body.content) {
          renderResult(result.body.content);
          console.log('[Fengshui] đã hiển thị kết quả');
        } else {
          showError((result.body && result.body.error) || 'Không nhận được kết quả.');
          resetPlaceholder();
        }
      })
      .catch(function (err) {
        console.log('[Fengshui] catch error:', err);
        setLoading(false);
        showError('Lỗi kết nối: ' + (err && err.message ? err.message : 'Không xác định'));
        resetPlaceholder();
      });
  };

  console.log('[Fengshui] onCalc assigned');

  function init() {
    console.log('[Fengshui] init() run');
    ['husband-name', 'husband-dob', 'wife-name', 'wife-dob'].forEach(function (id) {
      var input = el(id);
      if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') onCalc(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
