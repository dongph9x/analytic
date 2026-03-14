let rawData = null;

async function fetchData(forceRefresh = false) {
  const url = forceRefresh ? '/api/prices?refresh=1' : '/api/prices';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Không thể tải dữ liệu từ API');
  }
  return res.json();
}

function calcChange(values) {
  if (!values || values.length < 2) return null;
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  return ((last - prev) / prev) * 100;
}

function formatNumber(num, decimals = 2) {
  if (num == null || Number.isNaN(num)) return '--';
  return num.toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatChange(change) {
  if (change == null || Number.isNaN(change)) return '--';
  const sign = change >= 0 ? '+' : '';
  const cls = change >= 0 ? 'change-up' : 'change-down';
  return `<span class="${cls}">${sign}${formatNumber(change, 2)}%</span>`;
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

  const goldChange = calcChange(rawData.gold.values);
  const ron95Change = calcChange(rawData.fuelRON95.values);
  const doChange = calcChange(rawData.fuelDO.values);

  const rows = [
    {
      name: 'Vàng nhẫn trơn 9999',
      mua: rawData.gold.current,
      ban: rawData.gold.currentSell,
      unit: rawData.gold.unit,
      change: goldChange
    },
    {
      name: 'Xăng RON 95',
      mua: rawData.fuelRON95.current,
      ban: null,
      unit: rawData.fuelRON95.unit,
      change: ron95Change
    },
    {
      name: 'Dầu',
      mua: rawData.fuelDO.current,
      ban: null,
      unit: rawData.fuelDO.unit,
      change: doChange
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
      <td>${formatChange(r.change)}</td>
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
  rawData = await fetchData(forceRefresh);
  renderTable();
}

async function init() {
  const el = document.getElementById('price-tbody');
  if (el) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px;">Đang tải...</td></tr>';

  try {
    await loadData(false);
  } catch (err) {
    console.error(err);
    if (el) el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">Không thể tải dữ liệu. Thử Làm mới hoặc kiểm tra server.</td></tr>';
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
}

document.addEventListener('DOMContentLoaded', init);
