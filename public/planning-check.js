(function () {
  var map = null;
  var marker = null;
  var lastCoords = null;
  var defaultCenter = [16.0, 108.0];
  var defaultZoom = 6;

  /**
   * Parse DMS string like 11°35'03.2"N 107°45'24.3"E to { lat, lng }.
   * Cũng chấp nhận: 11° 35' 03.2" N, 107° 45' 24.3" E
   */
  function parseDMS(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim().replace(/\s+/g, ' ');
    var latMatch = str.match(/(\d+)[°º]\s*(\d+)['′]\s*([\d.]+)["″]?\s*([NS])/i);
    var lngMatch = str.match(/(\d+)[°º]\s*(\d+)['′]\s*([\d.]+)["″]?\s*([EW])/i);
    if (!latMatch || !lngMatch) return null;
    var lat = parseInt(latMatch[1], 10) + parseInt(latMatch[2], 10) / 60 + parseFloat(latMatch[3]) / 3600;
    if (latMatch[4].toUpperCase() === 'S') lat = -lat;
    var lng = parseInt(lngMatch[1], 10) + parseInt(lngMatch[2], 10) / 60 + parseFloat(lngMatch[3]) / 3600;
    if (lngMatch[4].toUpperCase() === 'W') lng = -lng;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  /**
   * Parse decimal "lat, lng" or "lat,lng".
   */
  function parseDecimal(str) {
    if (!str || typeof str !== 'string') return null;
    var parts = str.trim().split(/[\s,]+/);
    if (parts.length < 2) return null;
    var lat = parseFloat(parts[0]);
    var lng = parseFloat(parts[1]);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  /**
   * Extract lat,lng from Google Maps URL.
   * Supports: @lat,lng or !3dLat!4dLng or place/.../@lat,lng
   */
  function parseGoogleMapsUrl(url) {
    if (!url || typeof url !== 'string') return null;
    var decoded = decodeURIComponent(url);
    var m = decoded.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = decoded.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = decoded.match(/place\/[^/]+\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    return null;
  }

  function parseCoords(coordText, mapLink) {
    var fromDms = parseDMS(coordText);
    if (fromDms) return fromDms;
    var fromDec = parseDecimal(coordText);
    if (fromDec) return fromDec;
    if (mapLink) {
      var fromUrl = parseGoogleMapsUrl(mapLink);
      if (fromUrl) return fromUrl;
    }
    return null;
  }

  function initMap() {
    if (map) return;
    map = L.map('map').setView(defaultCenter, defaultZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
  }

  function setMarker(lat, lng) {
    initMap();
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lng]).addTo(map);
    map.setView([lat, lng], 16);
  }

  function showResult(msg, isError) {
    var el = document.getElementById('coord-result');
    if (!el) return;
    el.textContent = msg;
    el.className = 'coord-result' + (isError ? ' error' : '');
    if (!isError) el.innerHTML = '<strong>Vị trí:</strong> ' + msg;
  }

  function runCheck() {
    var mapLink = (document.getElementById('input-map-link') && document.getElementById('input-map-link').value && document.getElementById('input-map-link').value.trim()) || '';
    var coords = mapLink ? parseCoords('', mapLink) : null;
    if (!coords) {
      showResult('Không đọc được vị trí từ link. Dán link Google Maps có chứa tọa độ (ví dụ dạng @lat,lng hoặc place có vị trí).', true);
      lastCoords = null;
      return;
    }
    lastCoords = coords;
    setMarker(coords.lat, coords.lng);
    showResult('Đã đặt marker trên bản đồ. Có thể bấm «Kiểm tra quy hoạch bằng ChatGPT» bên dưới.', false);
  }

  function showPlanningReportLoading(show) {
    var el = document.getElementById('planning-report-loading');
    if (el) el.classList.toggle('hidden', !show);
  }

  function showPlanningReportError(msg) {
    var el = document.getElementById('planning-report-error');
    var contentEl = document.getElementById('planning-report-content');
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('hidden', !msg);
    }
    if (contentEl) contentEl.classList.add('hidden');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function linkify(text) {
    return text.replace(
      /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g,
      function (_, url) {
        var href = url.replace(/[.,;:)]+$/, '');
        return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(href) + '</a>';
      }
    );
  }

  function renderReportHtml(rawText) {
    return linkify(escapeHtml(rawText)).replace(/\n/g, '<br>\n');
  }

  function showPlanningReportContent(text) {
    var contentEl = document.getElementById('planning-report-content');
    var errorEl = document.getElementById('planning-report-error');
    if (errorEl) errorEl.classList.add('hidden');
    if (contentEl) {
      contentEl.innerHTML = text ? renderReportHtml(text) : '';
      contentEl.classList.toggle('hidden', !text);
    }
  }

  function runPlanningReport() {
    if (!lastCoords) {
      showPlanningReportError('Vui lòng nhập link Google Map và bấm «Kiểm tra vị trí trên bản đồ» trước.');
      return;
    }
    showPlanningReportError('');
    showPlanningReportContent('');
    showPlanningReportLoading(true);

    var mapLinkInput = document.getElementById('input-map-link');
    var mapLink = (mapLinkInput && mapLinkInput.value && mapLinkInput.value.trim()) || null;
    window.apiFetch('/api/planning-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: lastCoords.lat, lng: lastCoords.lng, mapLink: mapLink })
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (body) {
            var msg = body;
            try {
              var j = JSON.parse(body);
              if (j.error) msg = j.error;
            } catch (_) {}
            throw new Error(msg || 'Lỗi ' + res.status);
          });
        }
        if (!res.body) throw new Error('Không có dữ liệu stream');
        return res.body.getReader();
      })
      .then(function (reader) {
        var contentEl = document.getElementById('planning-report-content');
        if (!contentEl) return;
        contentEl.classList.remove('hidden');
        var decoder = new TextDecoder();
        var accumulated = '';
        function readNext() {
          reader.read().then(function (result) {
            if (result.done) {
              showPlanningReportLoading(false);
              return;
            }
            accumulated += decoder.decode(result.value, { stream: true });
            contentEl.innerHTML = renderReportHtml(accumulated);
            contentEl.scrollTop = contentEl.scrollHeight;
            readNext();
          }).catch(function (err) {
            showPlanningReportLoading(false);
            showPlanningReportError(err.message || 'Lỗi khi đọc stream.');
          });
        }
        readNext();
      })
      .catch(function (err) {
        showPlanningReportLoading(false);
        showPlanningReportError(err.message || 'Không thể tạo báo cáo. Kiểm tra kết nối hoặc cấu hình server.');
      });
  }

  var btn = document.getElementById('btn-check');
  if (btn) btn.addEventListener('click', runCheck);

  var btnReport = document.getElementById('btn-planning-report');
  if (btnReport) btnReport.addEventListener('click', runPlanningReport);

  initMap();
})();
