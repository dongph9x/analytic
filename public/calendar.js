(function () {
  const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const MONTH_NAMES_VI = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
  const CHI_NAMES = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];
  const HOUR_RANGES = [
    '23h–01h', '01h–03h', '03h–05h', '05h–07h', '07h–09h', '09h–11h',
    '11h–13h', '13h–15h', '15h–17h', '17h–19h', '19h–21h', '21h–23h'
  ];

  /** Định dạng ngày đúng dd/mm/yyyy (2 chữ số ngày, 2 chữ số tháng, 4 chữ số năm). */
  function formatDateVI(d) {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return day + '/' + month + '/' + year;
  }

  /** Parse chuỗi dd/mm/yyyy → Date hoặc null. Chấp nhận d/m/yyyy. */
  function parseDateVI(str) {
    if (!str || typeof str !== 'string') return null;
    const parts = str.trim().split('/');
    if (parts.length !== 3) return null;
    const d = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const y = parseInt(parts[2], 10);
    if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return null;
    if (d < 1 || d > 31 || m < 0 || m > 11 || y < 1900 || y > 2100) return null;
    const date = new Date(y, m, d);
    if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
    return date;
  }

  function julianDay(y, m, d) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
  }

  /** Địa chi của ngày (0–11) từ ngày dương lịch. */
  function getDayZhiIndex(y, m, d) {
    const jd = Math.floor(julianDay(y, m, d) + 0.5);
    return (jd + 8) % 12;
  }

  /** 6 giờ hoàng đạo theo ngày: [chi, chi+2, ..., chi+10] % 12. */
  function getHoangDaoHours(chiIndex) {
    return [0, 2, 4, 6, 8, 10].map(function (k) {
      return (chiIndex + k) % 12;
    });
  }

  function renderSolar(date) {
    const weekday = WEEKDAYS[date.getDay()];
    const dateStr = formatDateVI(date);
    document.getElementById('solar-content').innerHTML =
      '<span class="label">Ngày</span><span class="value">' + dateStr + '</span>' +
      '<span class="label">Thứ</span><span class="value">' + weekday + '</span>';
  }

  function renderLunar(date) {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const day = date.getDate();
    const elContent = document.getElementById('lunar-content');
    const elChi = document.getElementById('day-chi');
    try {
      if (typeof Solar !== 'undefined' && Solar.fromYmd) {
        const solar = Solar.fromYmd(y, m, day);
        const lunar = solar.getLunar && solar.getLunar();
        if (lunar) {
          const ly = lunar.getYear ? lunar.getYear() : '';
          const lm = lunar.getMonth ? lunar.getMonth() : '';
          const ld = lunar.getDay ? lunar.getDay() : '';
          const leapStr = (lunar.isLeapMonth && lunar.isLeapMonth()) ? ' (nhuận)' : '';
          elContent.innerHTML =
            '<span class="label">Ngày âm</span><span class="value">' + ld + '/' + lm + '/' + ly + leapStr + '</span>' +
            '<span class="label">Can chi ngày</span><span class="value" id="lunar-day-ganzhi"></span>';
          if (lunar.getDayInGanZhi) {
            var gz = lunar.getDayInGanZhi();
            var chiVn = (gz || '').replace(/子/g, 'Tý').replace(/丑/g, 'Sửu').replace(/寅/g, 'Dần').replace(/卯/g, 'Mão').replace(/辰/g, 'Thìn').replace(/巳/g, 'Tỵ').replace(/午/g, 'Ngọ').replace(/未/g, 'Mùi').replace(/申/g, 'Thân').replace(/酉/g, 'Dậu').replace(/戌/g, 'Tuất').replace(/亥/g, 'Hợi');
            var ganZhiVn = chiVn.replace(/甲/g, 'Giáp').replace(/乙/g, 'Ất').replace(/丙/g, 'Bính').replace(/丁/g, 'Đinh').replace(/戊/g, 'Mậu').replace(/己/g, 'Kỷ').replace(/庚/g, 'Canh').replace(/辛/g, 'Tân').replace(/壬/g, 'Nhâm').replace(/癸/g, 'Quý');
            var elGz = document.getElementById('lunar-day-ganzhi');
            if (elGz) elGz.textContent = ganZhiVn || gz;
          }
          var dayChiIndex = (typeof lunar.getDayZhiIndex === 'function') ? lunar.getDayZhiIndex() : getDayZhiIndex(y, m, day);
          elChi.textContent = 'Ngày ' + CHI_NAMES[dayChiIndex] + ' – bảng giờ hoàng đạo / hắc đạo theo ngày.';
          return dayChiIndex;
        }
      }
    } catch (e) {
      console.warn('Lunar lib:', e);
    }
    elContent.innerHTML =
      '<span class="label">Ngày âm</span><span class="value">—</span>' +
      '<span class="label">Can chi ngày</span><span class="value">—</span>';
    elChi.textContent = 'Dùng địa chi ngày (từ dương lịch) để tính giờ hoàng đạo.';
    return getDayZhiIndex(y, m, day);
  }

  function renderHourTable(chiIndex) {
    const good = getHoangDaoHours(chiIndex);
    const tbody = document.getElementById('hour-tbody');
    let html = '';
    for (let i = 0; i < 12; i++) {
      const isGood = good.indexOf(i) >= 0;
      html += '<tr>' +
        '<td>' + CHI_NAMES[i] + '</td>' +
        '<td>' + HOUR_RANGES[i] + '</td>' +
        '<td class="' + (isGood ? 'hour-good' : 'hour-bad') + '">' + (isGood ? 'Hoàng đạo (tốt)' : 'Hắc đạo (xấu)') + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  function update(date) {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    renderSolar(date);
    let chiIndex = renderLunar(date);
    if (typeof chiIndex !== 'number') chiIndex = getDayZhiIndex(y, m, d);
    renderHourTable(chiIndex);
  }

  const input = document.getElementById('input-date');
  const dropdownEl = document.getElementById('calendar-dropdown');
  var lastValidDate = new Date();
  var viewMonth = new Date(lastValidDate.getFullYear(), lastValidDate.getMonth(), 1);

  function setDate(date) {
    lastValidDate = date;
    viewMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    input.value = formatDateVI(date);
    update(date);
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function renderCalendarPopup() {
    if (!dropdownEl) return;
    var y = viewMonth.getFullYear();
    var m = viewMonth.getMonth();
    var first = new Date(y, m, 1);
    var last = new Date(y, m + 1, 0);
    var startOffset = first.getDay();
    var daysInMonth = last.getDate();
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var html = '<div class="cal-header">';
    html += '<button type="button" class="cal-prev" aria-label="Tháng trước">‹</button>';
    html += '<span class="cal-title">' + MONTH_NAMES_VI[m] + ' ' + y + '</span>';
    html += '<button type="button" class="cal-next" aria-label="Tháng sau">›</button>';
    html += '</div>';
    html += '<div class="cal-weekdays">' + WEEKDAY_SHORT.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days">';

    var i;
    for (i = 0; i < startOffset; i++) {
      var prevMonth = new Date(y, m, -startOffset + i + 1);
      html += '<button type="button" class="cal-day other-month" data-date="' + prevMonth.getTime() + '">' + prevMonth.getDate() + '</button>';
    }
    for (i = 1; i <= daysInMonth; i++) {
      var d = new Date(y, m, i);
      var cls = 'cal-day';
      if (d.getMonth() !== m) cls += ' other-month';
      if (isSameDay(d, today)) cls += ' today';
      if (isSameDay(d, lastValidDate)) cls += ' selected';
      html += '<button type="button" class="' + cls + '" data-date="' + d.getTime() + '">' + i + '</button>';
    }
    var totalCells = startOffset + daysInMonth;
    var remaining = totalCells % 7 ? 7 - (totalCells % 7) : 0;
    for (i = 0; i < remaining; i++) {
      var nextD = new Date(y, m + 1, i + 1);
      html += '<button type="button" class="cal-day other-month" data-date="' + nextD.getTime() + '">' + nextD.getDate() + '</button>';
    }
    html += '</div>';
    dropdownEl.innerHTML = html;
    dropdownEl.removeAttribute('aria-hidden');

    dropdownEl.querySelector('.cal-prev').addEventListener('click', function () {
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
      renderCalendarPopup();
    });
    dropdownEl.querySelector('.cal-next').addEventListener('click', function () {
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
      renderCalendarPopup();
    });
    dropdownEl.querySelectorAll('.cal-day').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var t = parseInt(btn.getAttribute('data-date'), 10);
        if (!Number.isNaN(t)) {
          setDate(new Date(t));
          hideCalendar();
        }
      });
    });
  }

  function showCalendar() {
    viewMonth = new Date(lastValidDate.getFullYear(), lastValidDate.getMonth(), 1);
    renderCalendarPopup();
    dropdownEl.classList.remove('hidden');
  }

  function hideCalendar() {
    dropdownEl.classList.add('hidden');
    dropdownEl.setAttribute('aria-hidden', 'true');
  }

  if (input) {
    input.value = formatDateVI(new Date());
    input.placeholder = 'dd/mm/yyyy';
    input.addEventListener('focus', showCalendar);
    input.addEventListener('click', showCalendar);
    input.addEventListener('change', function () {
      var parsed = parseDateVI(input.value);
      if (parsed) setDate(parsed);
      else input.value = formatDateVI(lastValidDate);
    });
    input.addEventListener('blur', function () {
      var parsed = parseDateVI(input.value);
      if (parsed) setDate(parsed);
      else input.value = formatDateVI(lastValidDate);
    });
  }

  document.addEventListener('click', function (e) {
    if (!dropdownEl || dropdownEl.classList.contains('hidden')) return;
    var wrap = input && input.closest('.input-and-picker');
    if (wrap && !wrap.contains(e.target)) hideCalendar();
  });

  update(new Date());
})();
