(() => {
  'use strict';

  const config = window.QR_INVENTORY_CONFIG || {};
  const appUrl = String(config.APPS_SCRIPT_URL || '').trim();
  const elements = {
    status: document.getElementById('status'),
    startButton: document.getElementById('startButton'),
    stopButton: document.getElementById('stopButton'),
    productIdInput: document.getElementById('productIdInput'),
    manualButton: document.getElementById('manualButton')
  };

  let scanner = null;
  let running = false;
  let locked = false;

  function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = 'status' + (type ? ' ' + type : '');
  }

  function normalizeProductId(value) {
    return String(value || '').trim().replace(/[－ー―]/g, '-').toUpperCase();
  }

  function extractProductId(decodedText) {
    const text = String(decodedText || '').trim();

    try {
      const url = new URL(text);
      const fromQuery = url.searchParams.get('id') || url.searchParams.get('productId');
      if (fromQuery && /^3F-\d{5,}$/i.test(normalizeProductId(fromQuery))) {
        return normalizeProductId(fromQuery);
      }
    } catch (error) {
      // URLでないQRは下の正規表現で確認する。
    }

    const match = normalizeProductId(text).match(/3F-\d{5,}/i);
    return match ? normalizeProductId(match[0]) : '';
  }

  function scannerReturnUrl() {
    return window.location.origin + window.location.pathname + '?autostart=1';
  }

  function openProduct(productId) {
    const id = normalizeProductId(productId);
    if (!/^3F-\d{5,}$/.test(id)) {
      setStatus('商品IDを読み取れませんでした。棚卸用QRをかざしてください。', 'error');
      locked = false;
      return;
    }

    const separator = appUrl.includes('?') ? '&' : '?';
    const target = appUrl + separator +
      'id=' + encodeURIComponent(id) +
      '&returnUrl=' + encodeURIComponent(scannerReturnUrl());

    setStatus(id + ' を読み取りました。商品画面を開きます。', 'success');
    window.setTimeout(() => window.location.assign(target), 180);
  }

  async function handleScan(decodedText) {
    if (locked) return;
    locked = true;
    const productId = extractProductId(decodedText);

    if (!productId) {
      setStatus('棚卸用の商品IDが入っていないQRです。', 'error');
      window.setTimeout(() => { locked = false; }, 900);
      return;
    }

    try {
      if (scanner && running) {
        await scanner.stop();
        running = false;
      }
    } catch (error) {
      // 停止できなくても画面遷移は続行する。
    }

    openProduct(productId);
  }

  async function startScanner() {
    if (running || locked) return;

    if (!appUrl || !/^https:\/\//.test(appUrl)) {
      setStatus('config.jsのApps Script URLを確認してください。', 'error');
      return;
    }

    if (typeof Html5Qrcode !== 'function') {
      setStatus('QR読取機能を読み込めませんでした。通信状態を確認してください。', 'error');
      return;
    }

    elements.startButton.disabled = true;
    setStatus('カメラを起動しています。');

    try {
      if (!scanner) scanner = new Html5Qrcode('reader', false);

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 12,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.68);
            return { width: size, height: size };
          },
          aspectRatio: 1.333333,
          disableFlip: false,
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]
        },
        handleScan,
        () => {}
      );

      running = true;
      locked = false;
      elements.stopButton.disabled = false;
      setStatus('カメラ起動中。QRを枠内へかざしてください。', 'success');
    } catch (error) {
      running = false;
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      const detail = error && error.message ? error.message : String(error || '');
      setStatus('カメラを起動できませんでした。ブラウザのカメラ権限を許可してください。' + (detail ? ' ' + detail : ''), 'error');
    }
  }

  async function stopScanner() {
    if (!scanner || !running) return;
    try {
      await scanner.stop();
      running = false;
      locked = false;
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      setStatus('カメラを停止しました。');
    } catch (error) {
      setStatus('カメラを停止できませんでした。ページを再読み込みしてください。', 'error');
    }
  }

  function manualOpen() {
    const id = normalizeProductId(elements.productIdInput.value);
    openProduct(id);
  }

  elements.startButton.addEventListener('click', startScanner);
  elements.stopButton.addEventListener('click', stopScanner);
  elements.manualButton.addEventListener('click', manualOpen);
  elements.productIdInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') manualOpen();
  });

  window.addEventListener('pagehide', () => {
    if (scanner && running) scanner.stop().catch(() => {});
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get('autostart') === '1') {
    window.setTimeout(startScanner, 350);
  }
})();
