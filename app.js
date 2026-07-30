(() => {
  'use strict';

  const config = window.QR_INVENTORY_CONFIG || {};
  const appUrl = String(config.APPS_SCRIPT_URL || '').trim();
  const REQUEST_TIMEOUT_MS = 20000;

  const elements = {
    status: document.getElementById('status'),
    startButton: document.getElementById('startButton'),
    stopButton: document.getElementById('stopButton'),
    productIdInput: document.getElementById('productIdInput'),
    manualButton: document.getElementById('manualButton'),
    completedCount: document.getElementById('completedCount'),
    remainingCount: document.getElementById('remainingCount'),
    progressPercent: document.getElementById('progressPercent'),
    productOverlay: document.getElementById('productOverlay'),
    closeOverlayButton: document.getElementById('closeOverlayButton'),
    overlayLoading: document.getElementById('overlayLoading'),
    productContent: document.getElementById('productContent'),
    overlayProductId: document.getElementById('overlayProductId'),
    overlayProductName: document.getElementById('overlayProductName'),
    overlayProductType: document.getElementById('overlayProductType'),
    overlayShelf: document.getElementById('overlayShelf'),
    overlayCode: document.getElementById('overlayCode'),
    overlayCost: document.getElementById('overlayCost'),
    overlayPreviousCount: document.getElementById('overlayPreviousCount'),
    overlayLastInput: document.getElementById('overlayLastInput'),
    operatorInput: document.getElementById('operatorInput'),
    historyValue: document.getElementById('historyValue'),
    totalValue: document.getElementById('totalValue'),
    plusTenButton: document.getElementById('plusTenButton'),
    plusOneButton: document.getElementById('plusOneButton'),
    undoButton: document.getElementById('undoButton'),
    clearButton: document.getElementById('clearButton'),
    entryInput: document.getElementById('entryInput'),
    addEntryButton: document.getElementById('addEntryButton'),
    saveButton: document.getElementById('saveButton'),
    overlayMessage: document.getElementById('overlayMessage'),
    dataBridge: document.getElementById('dataBridge')
  };

  const state = {
    scanner: null,
    running: false,
    scanLocked: false,
    bridgeReady: false,
    product: null,
    entries: [],
    saving: false,
    pendingRequests: new Map(),
    requestSequence: 0,
    lastScannedId: '',
    ignoreSameCodeUntil: 0
  };

  function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = 'status' + (type ? ' ' + type : '');
  }

  function normalizeProductId(value) {
    return String(value || '')
      .trim()
      .replace(/[－ー―]/g, '-')
      .toUpperCase();
  }

  function extractProductId(decodedText) {
    const text = String(decodedText || '').trim();

    try {
      const url = new URL(text);
      const fromQuery =
        url.searchParams.get('id') ||
        url.searchParams.get('productId');

      if (
        fromQuery &&
        /^3F-\d{5,}$/i.test(normalizeProductId(fromQuery))
      ) {
        return normalizeProductId(fromQuery);
      }
    } catch (error) {
      // URLでないQRは正規表現で確認する。
    }

    const match = normalizeProductId(text).match(/3F-\d{5,}/i);
    return match ? normalizeProductId(match[0]) : '';
  }

  function createBridgeUrl() {
    const separator = appUrl.includes('?') ? '&' : '?';
    return appUrl + separator +
      'mode=bridge&parentOrigin=' +
      encodeURIComponent(window.location.origin);
  }

  function initializeBridge() {
    if (!appUrl || !/^https:\/\//i.test(appUrl)) {
      setStatus('config.jsのApps Script URLを確認してください。', 'error');
      return;
    }

    try {
      new URL(appUrl);
    } catch (error) {
      setStatus('Apps Script URLが正しくありません。', 'error');
      return;
    }

    elements.dataBridge.src = createBridgeUrl();
  }

  function bridgeRequest(action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!state.bridgeReady || !elements.dataBridge.contentWindow) {
        reject(new Error('棚卸データとの接続準備が終わっていません。'));
        return;
      }

      const requestId =
        Date.now().toString(36) + '-' +
        (++state.requestSequence).toString(36);

      const timeoutId = window.setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error('通信がタイムアウトしました。'));
      }, REQUEST_TIMEOUT_MS);

      state.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId
      });

      elements.dataBridge.contentWindow.postMessage(
        {
          source: 'otobe-inventory-scanner',
          type: 'request',
          requestId,
          action,
          payload
        },
        '*'
      );
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== elements.dataBridge.contentWindow) {
      return;
    }

    const message = event.data || {};

    if (message.source !== 'otobe-inventory-bridge') {
      return;
    }

    if (message.type === 'ready') {
      state.bridgeReady = true;
      elements.startButton.disabled = false;
      setStatus('準備完了。「カメラを起動」を押してください。', 'success');
      refreshProgress();
      return;
    }

    if (message.type !== 'response' || !message.requestId) {
      return;
    }

    const pending = state.pendingRequests.get(message.requestId);

    if (!pending) {
      return;
    }

    window.clearTimeout(pending.timeoutId);
    state.pendingRequests.delete(message.requestId);

    if (message.ok) {
      pending.resolve(message.data);
    } else {
      pending.reject(
        new Error(message.error || '棚卸データとの通信に失敗しました。')
      );
    }
  });

  function parseHistory(history, fallbackTotal) {
    const text = String(history || '')
      .replace(/[＋]/g, '+')
      .replace(/\s/g, '');
    const matches = text.match(/\+(\d+)/g);

    if (matches && matches.join('') === text) {
      return matches.map(value => Number(value.slice(1)));
    }

    if (
      fallbackTotal !== '' &&
      fallbackTotal !== null &&
      Number.isInteger(Number(fallbackTotal))
    ) {
      return [Number(fallbackTotal)];
    }

    return [];
  }

  function currentHistory() {
    return state.entries.map(value => '+' + value).join('');
  }

  function currentTotal() {
    return state.entries.reduce((sum, value) => sum + value, 0);
  }

  function renderCount() {
    elements.historyValue.textContent = currentHistory() || '未入力';
    elements.totalValue.textContent =
      currentTotal().toLocaleString('ja-JP');
    elements.undoButton.disabled =
      state.saving || state.entries.length === 0;
    elements.clearButton.disabled =
      state.saving || state.entries.length === 0;
  }

  function clearOverlayMessage() {
    elements.overlayMessage.textContent = '';
    elements.overlayMessage.className = 'overlay-message';
  }

  function showOverlayMessage(message, type) {
    elements.overlayMessage.textContent = message;
    elements.overlayMessage.className =
      'overlay-message visible ' + type;
  }

  function setOverlayLoading(isLoading) {
    elements.overlayLoading.hidden = !isLoading;
    elements.productContent.hidden = isLoading;
  }

  function setSaving(isSaving) {
    state.saving = isSaving;
    [
      elements.saveButton,
      elements.plusTenButton,
      elements.plusOneButton,
      elements.addEntryButton,
      elements.closeOverlayButton
    ].forEach(button => {
      button.disabled = isSaving;
    });
    renderCount();
  }

  function openOverlay() {
    elements.productOverlay.classList.add('visible');
    elements.productOverlay.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('overlay-open');
    document.body.classList.add('overlay-open');
  }

  function closeOverlay(options = {}) {
    if (state.saving) {
      return;
    }

    elements.productOverlay.classList.remove('visible');
    elements.productOverlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('overlay-open');
    document.body.classList.remove('overlay-open');
    clearOverlayMessage();
    state.product = null;
    state.entries = [];
    elements.entryInput.value = '';
    state.scanLocked = false;
    state.ignoreSameCodeUntil = Date.now() + 1400;

    if (options.saved) {
      setStatus('登録しました。次のQRをかざしてください。', 'success');
    } else if (state.running) {
      setStatus('カメラ起動中。次のQRを枠内へかざしてください。', 'success');
    }
  }

  function renderProduct(product) {
    state.product = product;
    setSaving(false);
    state.entries = parseHistory(
      product.countHistory,
      product.currentCount
    );

    elements.overlayProductId.textContent = product.id || '-';
    elements.overlayProductName.textContent =
      product.name || '商品名未登録';
    elements.overlayProductType.textContent = product.type || '';
    elements.overlayShelf.textContent = product.shelf || '-';
    elements.overlayCode.textContent = product.code || '-';
    elements.overlayCost.textContent = product.cost
      ? product.cost + '円'
      : '-';
    elements.overlayPreviousCount.textContent =
      product.previousCount || '-';
    elements.overlayLastInput.textContent = [
      product.inputAt || '',
      product.inputBy ? '入力者：' + product.inputBy : ''
    ].filter(Boolean).join(' / ') || '未入力';

    elements.entryInput.value = '';
    renderCount();
    clearOverlayMessage();
    setOverlayLoading(false);

    window.setTimeout(() => {
      elements.entryInput.focus();
    }, 80);
  }

  async function showProduct(productId) {
    const id = normalizeProductId(productId);

    if (!/^3F-\d{5,}$/.test(id)) {
      setStatus(
        '商品IDを読み取れませんでした。棚卸用QRをかざしてください。',
        'error'
      );
      state.scanLocked = false;
      return;
    }

    state.scanLocked = true;
    openOverlay();
    setOverlayLoading(true);
    clearOverlayMessage();
    elements.overlayProductId.textContent = id;
    elements.overlayProductName.textContent = '商品情報を確認中';
    elements.overlayProductType.textContent = '';

    try {
      const response = await bridgeRequest('getProduct', {
        productId: id
      });

      if (!response || !response.ok) {
        throw new Error(
          response && response.message
            ? response.message
            : '商品を取得できませんでした。'
        );
      }

      renderProduct(response.product);
      state.lastScannedId = id;
    } catch (error) {
      setOverlayLoading(false);
      elements.productContent.hidden = false;
      showOverlayMessage(
        error && error.message
          ? error.message
          : '商品を取得できませんでした。',
        'error'
      );
      elements.saveButton.disabled = true;
    }
  }

  async function handleScan(decodedText) {
    const productId = extractProductId(decodedText);

    if (!productId) {
      if (!state.scanLocked) {
        setStatus('棚卸用の商品IDが入っていないQRです。', 'error');
      }
      return;
    }

    if (state.scanLocked) {
      return;
    }

    if (
      productId === state.lastScannedId &&
      Date.now() < state.ignoreSameCodeUntil
    ) {
      return;
    }

    await showProduct(productId);
  }

  async function startScanner() {
    if (state.running || state.scanLocked) {
      return;
    }

    if (!state.bridgeReady) {
      setStatus('棚卸データとの接続準備中です。', 'error');
      return;
    }

    if (typeof Html5Qrcode !== 'function') {
      setStatus(
        'QR読取機能を読み込めませんでした。通信状態を確認してください。',
        'error'
      );
      return;
    }

    elements.startButton.disabled = true;
    setStatus('カメラを起動しています。');

    try {
      if (!state.scanner) {
        state.scanner = new Html5Qrcode('reader', false);
      }

      await state.scanner.start(
        { facingMode: 'environment' },
        {
          fps: 12,
          qrbox: (width, height) => {
            const size = Math.floor(
              Math.min(width, height) * .68
            );
            return { width: size, height: size };
          },
          aspectRatio: 1.333333,
          disableFlip: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE
          ]
        },
        handleScan,
        () => {}
      );

      state.running = true;
      state.scanLocked = false;
      elements.stopButton.disabled = false;
      setStatus(
        'カメラ起動中。QRを枠内へかざしてください。',
        'success'
      );
    } catch (error) {
      state.running = false;
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      const detail = error && error.message
        ? error.message
        : String(error || '');
      setStatus(
        'カメラを起動できませんでした。ブラウザのカメラ権限を許可してください。' +
        (detail ? ' ' + detail : ''),
        'error'
      );
    }
  }

  async function stopScanner() {
    if (!state.scanner || !state.running) {
      return;
    }

    try {
      await state.scanner.stop();
      state.running = false;
      state.scanLocked = false;
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      setStatus('カメラを停止しました。');
    } catch (error) {
      setStatus(
        'カメラを停止できませんでした。ページを再読み込みしてください。',
        'error'
      );
    }
  }

  function addValue(value) {
    if (state.saving) {
      return false;
    }

    const number = Number(value);

    if (!Number.isInteger(number) || number < 0) {
      showOverlayMessage('0以上の整数を入力してください。', 'error');
      return false;
    }

    state.entries.push(number);
    elements.entryInput.value = '';
    clearOverlayMessage();
    renderCount();
    elements.entryInput.focus();
    return true;
  }

  function commitPendingEntry() {
    const text = elements.entryInput.value;

    if (text === '') {
      return true;
    }

    return addValue(text);
  }

  async function saveInventory() {
    if (state.saving || !state.product) {
      return;
    }

    clearOverlayMessage();

    if (!commitPendingEntry()) {
      return;
    }

    if (state.entries.length === 0) {
      showOverlayMessage(
        '数量を入力してください。0個の場合は0を入力してください。',
        'error'
      );
      elements.entryInput.focus();
      return;
    }

    const operatorName = elements.operatorInput.value.trim();

    if (!operatorName) {
      showOverlayMessage('入力者名を入力してください。', 'error');
      elements.operatorInput.focus();
      return;
    }

    localStorage.setItem('inventoryOperatorName', operatorName);
    setSaving(true);

    try {
      const response = await bridgeRequest('saveInventory', {
        productId: state.product.id,
        history: currentHistory(),
        total: currentTotal(),
        operatorName
      });

      if (!response || !response.ok) {
        throw new Error(
          response && response.message
            ? response.message
            : '登録できませんでした。'
        );
      }

      showOverlayMessage(
        response.message || '棚卸数量を登録しました。',
        'success'
      );
      await refreshProgress();

      window.setTimeout(() => {
        setSaving(false);
        closeOverlay({ saved: true });
      }, 700);
    } catch (error) {
      setSaving(false);
      showOverlayMessage(
        error && error.message
          ? error.message
          : '登録中にエラーが発生しました。',
        'error'
      );
    }
  }

  async function refreshProgress() {
    if (!state.bridgeReady) {
      return;
    }

    try {
      const response = await bridgeRequest(
        'getInventoryProgress'
      );

      if (!response || !response.ok) {
        return;
      }

      elements.completedCount.textContent =
        Number(response.completed || 0).toLocaleString('ja-JP');
      elements.remainingCount.textContent =
        Number(response.remaining || 0).toLocaleString('ja-JP');
      elements.progressPercent.textContent =
        Number(response.percent || 0).toLocaleString('ja-JP') + '%';
    } catch (error) {
      console.error(error);
    }
  }

  function manualOpen() {
    if (state.scanLocked) {
      return;
    }

    showProduct(elements.productIdInput.value);
  }

  elements.startButton.addEventListener('click', startScanner);
  elements.stopButton.addEventListener('click', stopScanner);
  elements.manualButton.addEventListener('click', manualOpen);
  elements.productIdInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      manualOpen();
    }
  });

  elements.closeOverlayButton.addEventListener('click', () => {
    closeOverlay();
  });

  elements.plusTenButton.addEventListener('click', () => addValue(10));
  elements.plusOneButton.addEventListener('click', () => addValue(1));
  elements.addEntryButton.addEventListener('click', commitPendingEntry);
  elements.entryInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitPendingEntry();
    }
  });
  elements.undoButton.addEventListener('click', () => {
    state.entries.pop();
    renderCount();
    elements.entryInput.focus();
  });
  elements.clearButton.addEventListener('click', () => {
    if (
      state.entries.length &&
      window.confirm('加算履歴をすべて消しますか？')
    ) {
      state.entries = [];
      elements.entryInput.value = '';
      renderCount();
    }
  });
  elements.saveButton.addEventListener('click', saveInventory);

  window.addEventListener('pagehide', () => {
    if (state.scanner && state.running) {
      state.scanner.stop().catch(() => {});
    }
  });

  elements.operatorInput.value =
    localStorage.getItem('inventoryOperatorName') || '';
  renderCount();
  initializeBridge();
})();
