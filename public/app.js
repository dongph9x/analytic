const CACHE_KEY = 'analytic_prices';
const BACKGROUND_INTERVAL_MS = 10 * 60 * 1000; // 10 phút

let rawData = null;

function getFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.gold || !data.fuelRON95 || !data.fuelDO) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function setCache(data) {
  if (!data || !data.gold || !data.fuelRON95 || !data.fuelDO) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (_) {}
}

async function fetchData(forceRefresh = false) {
  const url = forceRefresh ? '/api/prices?refresh=1' : '/api/prices';
  const res = await window.apiFetch(url);
  if (!res.ok) {
    throw new Error('Không thể tải dữ liệu từ API');
  }
  return res.json();
}

/** Gọi API chỉ crawl bảng giá (PVOIL + Kim Tài Ngọc), trả về nhanh để hiển thị bảng ngay. */
async function fetchCurrentPrices() {
  const res = await window.apiFetch('/api/prices/current');
  if (!res.ok) {
    throw new Error('Không thể tải bảng giá hiện tại');
  }
  return res.json();
}

function calcChange(values) {
  if (!values || values.length < 2) return null;
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  return ((last - prev) / prev) * 100;
}

/** Trả về { change, prevValue } để hiển thị so sánh phiên trước. */
function getChangeAndPrev(values) {
  if (!values || values.length < 2) return { change: null, prevValue: null };
  const prev = values[values.length - 2];
  const last = values[values.length - 1];
  const change = ((last - prev) / prev) * 100;
  return { change, prevValue: prev };
}

function formatNumber(num, decimals = 2) {
  if (num == null || Number.isNaN(num)) return '--';
  return num.toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatChange(change, prevValue, currentValue) {
  const hasCompare = prevValue != null && currentValue != null && !Number.isNaN(prevValue) && !Number.isNaN(currentValue);
  const compareStr = hasCompare
    ? `<span class="change-compare">${formatNumber(prevValue)} → ${formatNumber(currentValue)}</span>`
    : '';
  if (change == null || Number.isNaN(change)) {
    return hasCompare ? compareStr : '--';
  }
  const sign = change >= 0 ? '+' : '';
  const cls = change >= 0 ? 'change-up' : 'change-down';
  const pctStr = `<span class="${cls}">${sign}${formatNumber(change, 2)}%</span>`;
  return hasCompare ? `${compareStr} <span class="change-pct">(${pctStr})</span>` : pctStr;
}

function renderTable() {
  const el = document.getElementById('price-tbody');
  const lastUpdateEl = document.getElementById('last-update');
  if (!el) return;

  if (!rawData || !rawData.gold || !rawData.fuelRON95 || !rawData.fuelDO) {
    el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">Không có dữ liệu. Kiểm tra kết nối hoặc thử Làm mới.</td></tr>';
    if (lastUpdateEl) lastUpdateEl.textContent = '--';
    return;
  }

  const goldCompare = getChangeAndPrev(rawData.gold.values);
  const ron95Compare = getChangeAndPrev(rawData.fuelRON95.values);
  const doCompare = getChangeAndPrev(rawData.fuelDO.values);

  const rows = [
    {
      name: 'Vàng nhẫn trơn 9999',
      mua: rawData.gold.current,
      ban: rawData.gold.currentSell,
      unit: rawData.gold.unit,
      change: goldCompare.change,
      prevValue: goldCompare.prevValue,
      currentValue: rawData.gold.current
    },
    {
      name: 'Xăng RON 95',
      mua: rawData.fuelRON95.current,
      ban: null,
      unit: rawData.fuelRON95.unit,
      change: ron95Compare.change,
      prevValue: ron95Compare.prevValue,
      currentValue: rawData.fuelRON95.current
    },
    {
      name: 'Dầu',
      mua: rawData.fuelDO.current,
      ban: null,
      unit: rawData.fuelDO.unit,
      change: doCompare.change,
      prevValue: doCompare.prevValue,
      currentValue: rawData.fuelDO.current
    }
  ];

  el.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.name}</td>
      <td class="price-cell">${formatNumber(r.mua)}</td>
      <td class="price-cell">${r.ban != null ? formatNumber(r.ban) : '--'}</td>
      <td class="unit-cell">${r.unit}</td>
      <td class="change-cell">${formatChange(r.change, r.prevValue, r.currentValue)}</td>
    </tr>
  `
    )
    .join('');

  if (lastUpdateEl) {
    try {
      const d = new Date(rawData.lastUpdate);
      lastUpdateEl.textContent = d.toLocaleString('vi-VN');
    } catch (_) {
      lastUpdateEl.textContent = rawData.lastUpdate || '--';
    }
  }
}

async function loadData(forceRefresh = false) {
  const fullUrl = forceRefresh ? '/api/prices?refresh=1' : '/api/prices';
  // Hiển thị bảng ngay khi có dữ liệu crawl (không đợi ChatGPT).
  try {
    const currentData = await fetchCurrentPrices();
    rawData = currentData;
    setCache(rawData);
    renderTable();
  } catch (_) {
    // Nếu /current lỗi, đợi luôn full data.
  }
  try {
    const res = await window.apiFetch(fullUrl);
    if (!res.ok) throw new Error('Không thể tải dữ liệu từ API');
    const fullData = await res.json();
    rawData = fullData;
    setCache(rawData);
    renderTable();
  } catch (err) {
    if (!rawData) throw err;
    console.warn('Full prices fetch failed:', err);
  }
}

async function init() {
  const el = document.getElementById('price-tbody');
  const cached = getFromCache();
  if (cached) {
    rawData = cached;
    renderTable();
  }
  if (!rawData && el) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px;">Đang tải...</td></tr>';

  try {
    await loadData(false);
  } catch (err) {
    console.error(err);
    if (el && !rawData) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">Không thể tải dữ liệu. Thử Làm mới hoặc kiểm tra server.</td></tr>';
  }

  const btn = document.getElementById('btn-refresh');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('loading');
      if (el) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px;">Đang tải...</td></tr>';
      try {
        await loadData(true);
      } catch (err) {
        console.error(err);
        if (el) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">Không thể tải lại dữ liệu.</td></tr>';
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });
  }

  // Job nền: cứ 10 phút fetch lại data và cập nhật cache + bảng.
  setInterval(() => {
    loadData(false).catch((err) => console.warn('Background refresh failed:', err));
  }, BACKGROUND_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
