(() => {
  'use strict';

  const config = window.QR_INVENTORY_CONFIG || {};
  const appUrl = String(config.APPS_SCRIPT_URL || '').trim();
  const REQUEST_TIMEOUT_MS = 30000;
  const CATALOG_CACHE_KEY = 'otobeInventoryCatalogV3';
  const SAVE_QUEUE_KEY = 'otobeInventorySaveQueueV3';
  const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const RETRY_DELAY_MS = 5000;

  const elements = {
    status: document.getElementById('status'),
    startButton: document.getElementById('startButton'),
    stopButton: document.getElementById('stopButton'),
    productIdInput: document.getElementById('productIdInput'),
    manualButton: document.getElementById('manualButton'),
    completedCount: document.getElementById('completedCount'),
    remainingCount: document.getElementById('remainingCount'),
    progressPercent: document.getElementById('progressPercent'),
    syncState: document.getElementById('syncState'),
    refreshDataButton: document.getElementById('refreshDataButton'),
    syncBar: document.querySelector('.sync-bar'),
    productOverlay: document.getElementById('productOverlay'),
    closeOverlayButton: document.getElementById('closeOverlayButton'),
    overlayLoading: document.getElementById('overlayLoading'),
    productContent: document.getElementById('productContent'),
    overlayProductId: document.getElementById('overlayProductId'),
    overlayProductName: document.getElementById('overlayProductName'),
    overlayProductType: document.getElementById('overlayProductType'),
    overlayShelf: document.getElementById('overlayShelf'),
    overlayLastInput: document.getElementById('overlayLastInput'),
    historyValue: document.getElementById('historyValue'),
    totalValue: document.getElementById('totalValue'),
    numberKeyButtons: Array.from(document.querySelectorAll('[data-number-key]')),
    multiplyButton: document.getElementById('multiplyButton'),
    entryClearButton: document.getElementById('entryClearButton'),
    entryBackspaceButton: document.getElementById('entryBackspaceButton'),
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
    bridgeQueue: Promise.resolve(),
    product: null,
    entries: [],
    saving: false,
    pendingRequests: new Map(),
    requestSequence: 0,
    lastScannedId: '',
    ignoreSameCodeUntil: 0,
    entryCommitted: false,
    catalog: new Map(),
    catalogLoaded: false,
    catalogUpdatedAt: 0,
    catalogRefreshing: false,
    pendingSaves: [],
    saveWorkerRunning: false,
    retryTimer: 0,
    syncError: ''
  };

  function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = 'status' + (type ? ' ' + type : '');
  }

  function setSyncState(message, type = '') {
    elements.syncState.textContent = message;
    elements.syncBar.className = 'sync-bar' + (type ? ' ' + type : '');
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

  function createBridgeRequestUrl(action, payload, requestId) {
    const url = new URL(appUrl);

    url.searchParams.set('mode', 'bridge');
    url.searchParams.set('bridgeAction', action);
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('parentOrigin', window.location.origin);
    url.searchParams.set('_ts', String(Date.now()));

    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    return url.toString();
  }

  function bridgeRequest(action, payload = {}) {
    const runRequest = () => new Promise((resolve, reject) => {
      if (!state.bridgeReady || !elements.dataBridge) {
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

      elements.dataBridge.src = createBridgeRequestUrl(
        action,
        payload,
        requestId
      );
    });

    const result = state.bridgeQueue.then(runRequest, runRequest);
    state.bridgeQueue = result.catch(() => {});
    return result;
  }

  window.addEventListener('message', event => {
    const message = event.data || {};

    if (
      message.source !== 'otobe-inventory-bridge' ||
      message.type !== 'response' ||
      !message.requestId
    ) {
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

  function normalizeTerm(value) {
    return String(value || '')
      .replace(/[＊*xXｘＸ]/g, '×')
      .replace(/[＋]/g, '+')
      .replace(/\s/g, '');
  }

  function evaluateTerm(term) {
    const normalized = normalizeTerm(term);

    if (!/^\d+(?:×\d+)*$/.test(normalized)) {
      throw new Error('数字または「数字×数字」の形式で入力してください。');
    }

    const factors = normalized.split('×').map(Number);
    let result = 1;

    factors.forEach(factor => {
      if (!Number.isSafeInteger(factor) || factor < 0) {
        throw new Error('0以上の整数だけ使用できます。');
      }

      result *= factor;

      if (!Number.isSafeInteger(result)) {
        throw new Error('計算結果が大きすぎます。');
      }
    });

    return result;
  }

  function parseHistory(history, fallbackTotal) {
    const text = normalizeTerm(history).replace(/^\+/, '');

    if (text) {
      const terms = text.split('+');

      try {
        terms.forEach(evaluateTerm);
        return terms;
      } catch (error) {
        // 旧データは総計へフォールバックする。
      }
    }

    if (
      fallbackTotal !== '' &&
      fallbackTotal !== null &&
      Number.isInteger(Number(fallbackTotal))
    ) {
      return [String(Number(fallbackTotal))];
    }

    return [];
  }

  function currentHistoryDisplay() {
    return state.entries.map(term => '+' + term).join('');
  }

  function currentStoredHistory() {
    return state.entries.join('+');
  }

  function currentTotal() {
    return state.entries.reduce(
      (sum, term) => sum + evaluateTerm(term),
      0
    );
  }

  function renderCount() {
    elements.historyValue.textContent =
      currentHistoryDisplay() || '未入力';
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
      ...elements.numberKeyButtons,
      elements.multiplyButton,
      elements.entryClearButton,
      elements.entryBackspaceButton,
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
    state.entryCommitted = false;
    state.scanLocked = false;
    state.ignoreSameCodeUntil = Date.now() + 900;

    if (options.queued) {
      setStatus('登録を受け付けました。次のQRをかざしてください。', 'success');
    } else if (state.running) {
      setStatus('カメラ起動中。次のQRを枠内へかざしてください。', 'success');
    }
  }

  function renderProduct(product) {
    state.product = { ...product };
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
    elements.overlayLastInput.textContent =
      product.inputAt || '未入力';

    elements.entryInput.value = '';
    state.entryCommitted = false;
    renderCount();
    clearOverlayMessage();
    setOverlayLoading(false);
  }

  function productIsCompleted(product) {
    return product &&
      product.currentCount !== '' &&
      product.currentCount !== null &&
      product.currentCount !== undefined;
  }

  function renderProgressFromCatalog() {
    const products = Array.from(state.catalog.values());
    const total = products.length;
    const completed = products.reduce(
      (count, product) => count + (productIsCompleted(product) ? 1 : 0),
      0
    );
    const percent = total === 0
      ? 0
      : Math.round((completed / total) * 1000) / 10;

    elements.completedCount.textContent =
      completed.toLocaleString('ja-JP');
    elements.remainingCount.textContent =
      (total - completed).toLocaleString('ja-JP');
    elements.progressPercent.textContent =
      percent.toLocaleString('ja-JP') + '%';
  }

  function serializeCatalog() {
    return {
      updatedAt: state.catalogUpdatedAt || Date.now(),
      products: Array.from(state.catalog.values())
    };
  }

  function persistCatalog() {
    try {
      localStorage.setItem(
        CATALOG_CACHE_KEY,
        JSON.stringify(serializeCatalog())
      );
    } catch (error) {
      console.warn('商品キャッシュを保存できませんでした。', error);
    }
  }

  function loadCatalogCache() {
    try {
      const raw = localStorage.getItem(CATALOG_CACHE_KEY);

      if (!raw) {
        return false;
      }

      const data = JSON.parse(raw);
      const products = Array.isArray(data.products)
        ? data.products
        : [];

      if (products.length === 0) {
        return false;
      }

      state.catalog.clear();
      products.forEach(product => {
        const id = normalizeProductId(product.id);
        if (id) {
          state.catalog.set(id, { ...product, id });
        }
      });
      state.catalogUpdatedAt = Number(data.updatedAt) || 0;
      state.catalogLoaded = state.catalog.size > 0;
      applyPendingSavesToCatalog();
      renderProgressFromCatalog();
      return state.catalogLoaded;
    } catch (error) {
      console.warn('商品キャッシュを読み込めませんでした。', error);
      return false;
    }
  }

  function loadSaveQueue() {
    try {
      const raw = localStorage.getItem(SAVE_QUEUE_KEY);
      const jobs = raw ? JSON.parse(raw) : [];
      state.pendingSaves = Array.isArray(jobs) ? jobs : [];
    } catch (error) {
      state.pendingSaves = [];
    }
  }

  function persistSaveQueue() {
    try {
      localStorage.setItem(
        SAVE_QUEUE_KEY,
        JSON.stringify(state.pendingSaves)
      );
    } catch (error) {
      console.warn('未送信データを保存できませんでした。', error);
    }
  }

  function applySaveToLocalProduct(payload, inputAt) {
    const id = normalizeProductId(payload.productId);
    const current = state.catalog.get(id) || {
      id,
      shelf: '',
      name: '商品情報更新中',
      type: ''
    };

    state.catalog.set(id, {
      ...current,
      currentCount: Number(payload.total),
      countHistory: String(payload.history || ''),
      inputAt: inputAt || new Date().toLocaleString('ja-JP')
    });
  }

  function applyPendingSavesToCatalog() {
    state.pendingSaves.forEach(job => {
      applySaveToLocalProduct(job.payload, job.createdDisplay);
    });
  }

  function updateSyncIndicator() {
    const pendingCount = state.pendingSaves.length;

    if (state.syncError) {
      setSyncState(state.syncError, 'error');
      return;
    }

    if (state.catalogRefreshing) {
      setSyncState('商品データを更新しています。', 'sending');
      return;
    }

    if (state.saveWorkerRunning || pendingCount > 0) {
      setSyncState(
        '登録を裏送信中：残り' + pendingCount + '件',
        'sending'
      );
      return;
    }

    const count = state.catalog.size;
    setSyncState(
      count > 0
        ? '高速読取準備済み：' + count.toLocaleString('ja-JP') + '商品'
        : '商品データ未取得',
      ''
    );
  }

  async function refreshCatalog(options = {}) {
    if (!state.bridgeReady || state.catalogRefreshing) {
      return false;
    }

    if (state.pendingSaves.length > 0 && !options.force) {
      return false;
    }

    state.catalogRefreshing = true;
    state.syncError = '';
    elements.refreshDataButton.disabled = true;
    updateSyncIndicator();

    try {
      const response = await bridgeRequest('getScannerCatalog');

      if (!response || !response.ok || !Array.isArray(response.products)) {
        throw new Error('商品一覧を取得できませんでした。');
      }

      state.catalog.clear();
      response.products.forEach(product => {
        const id = normalizeProductId(product.id);
        if (id) {
          state.catalog.set(id, { ...product, id });
        }
      });
      state.catalogLoaded = true;
      state.catalogUpdatedAt = Date.now();
      applyPendingSavesToCatalog();
      persistCatalog();
      renderProgressFromCatalog();
      elements.startButton.disabled = false;
      updateSyncIndicator();
      return true;
    } catch (error) {
      if (!state.catalogLoaded) {
        state.syncError = '商品データ取得失敗。QR読取時に個別取得します。';
        setSyncState(state.syncError, 'error');
        elements.startButton.disabled = false;
      } else {
        state.syncError = '商品データ更新に失敗しました。';
        setSyncState(state.syncError, 'error');
      }
      return false;
    } finally {
      state.catalogRefreshing = false;
      elements.refreshDataButton.disabled = false;
      updateSyncIndicator();
    }
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
    clearOverlayMessage();

    const cachedProduct = state.catalog.get(id);

    if (cachedProduct) {
      renderProduct(cachedProduct);
      state.lastScannedId = id;
      return;
    }

    setOverlayLoading(true);
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

      state.catalog.set(id, response.product);
      persistCatalog();
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
          fps: 18,
          qrbox: (width, height) => {
            const size = Math.floor(
              Math.min(width, height) * .74
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

    const term = normalizeTerm(value);

    if (term === '') {
      showOverlayMessage('数字ボタンで加算する数を入力してください。', 'error');
      return false;
    }

    try {
      evaluateTerm(term);
    } catch (error) {
      showOverlayMessage(error.message, 'error');
      return false;
    }

    state.entries.push(term);
    elements.entryInput.value = term;
    state.entryCommitted = true;
    clearOverlayMessage();
    renderCount();
    return true;
  }

  function sanitizeEntryValue(value) {
    return normalizeTerm(value).replace(/[^0-9×]/g, '');
  }

  function appendEntryDigit(digit) {
    if (state.saving) {
      return;
    }

    const cleanDigits = String(digit || '').replace(/[^0-9]/g, '');

    if (cleanDigits === '') {
      return;
    }

    let current = sanitizeEntryValue(elements.entryInput.value);

    if (state.entryCommitted || current === '') {
      current = cleanDigits === '00' ? '0' : cleanDigits;
    } else {
      const parts = current.split('×');
      const lastFactor = parts[parts.length - 1];

      if (lastFactor === '0') {
        parts[parts.length - 1] = cleanDigits === '00' ? '0' : cleanDigits;
        current = parts.join('×');
      } else {
        current += cleanDigits;
      }
    }

    elements.entryInput.value = current.slice(0, 24);
    state.entryCommitted = false;
    clearOverlayMessage();
  }

  function appendMultiplyOperator() {
    if (state.saving) {
      return;
    }

    const current = sanitizeEntryValue(elements.entryInput.value);

    if (!current || current.endsWith('×')) {
      showOverlayMessage('「×」の前に数字を入力してください。', 'error');
      return;
    }

    elements.entryInput.value = (current + '×').slice(0, 24);
    state.entryCommitted = false;
    clearOverlayMessage();
  }

  function clearEntryValue() {
    if (state.saving) {
      return;
    }

    elements.entryInput.value = '';
    state.entryCommitted = false;
    clearOverlayMessage();
  }

  function backspaceEntryValue() {
    if (state.saving) {
      return;
    }

    const current = sanitizeEntryValue(elements.entryInput.value);
    elements.entryInput.value = current.slice(0, -1);
    state.entryCommitted = false;
    clearOverlayMessage();
  }

  function commitPendingEntry(options = {}) {
    const text = sanitizeEntryValue(elements.entryInput.value);
    elements.entryInput.value = text;

    if (text === '') {
      return options.allowEmpty === true;
    }

    if (options.skipIfCommitted && state.entryCommitted) {
      return true;
    }

    return addValue(text);
  }

  function enqueueSave(payload) {
    const now = new Date();
    const job = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      payload,
      createdAt: now.toISOString(),
      createdDisplay: now.toLocaleString('ja-JP'),
      attempts: 0
    };

    state.pendingSaves.push(job);
    applySaveToLocalProduct(payload, job.createdDisplay);
    persistSaveQueue();
    persistCatalog();
    renderProgressFromCatalog();
    updateSyncIndicator();
    processSaveQueue();
  }

  function scheduleRetry() {
    if (state.retryTimer) {
      return;
    }

    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = 0;
      processSaveQueue();
    }, RETRY_DELAY_MS);
  }

  async function processSaveQueue() {
    if (
      state.saveWorkerRunning ||
      !state.bridgeReady ||
      state.pendingSaves.length === 0
    ) {
      updateSyncIndicator();
      return;
    }

    state.saveWorkerRunning = true;
    state.syncError = '';
    updateSyncIndicator();

    while (state.pendingSaves.length > 0) {
      const job = state.pendingSaves[0];

      try {
        const response = await bridgeRequest(
          'saveInventory',
          job.payload
        );

        if (!response || !response.ok) {
          throw new Error(
            response && response.message
              ? response.message
              : '登録できませんでした。'
          );
        }

        if (response.product) {
          const id = normalizeProductId(response.product.id);
          state.catalog.set(id, response.product);
        }

        state.pendingSaves.shift();
        state.syncError = '';
        persistSaveQueue();
        persistCatalog();
        renderProgressFromCatalog();
      } catch (error) {
        job.attempts = Number(job.attempts || 0) + 1;
        job.lastError = error && error.message
          ? error.message
          : '送信に失敗しました。';
        persistSaveQueue();
        state.syncError =
          '未送信' + state.pendingSaves.length + '件。自動再送します。';
        setSyncState(state.syncError, 'error');
        scheduleRetry();
        break;
      }
    }

    state.saveWorkerRunning = false;
    updateSyncIndicator();
  }

  function saveInventory() {
    if (state.saving || !state.product) {
      return;
    }

    clearOverlayMessage();

    if (!commitPendingEntry({
      allowEmpty: true,
      skipIfCommitted: true
    })) {
      return;
    }

    if (state.entries.length === 0) {
      showOverlayMessage(
        '数量を入力してください。0個の場合は0を入力してください。',
        'error'
      );
      return;
    }

    const payload = {
      productId: state.product.id,
      history: currentStoredHistory(),
      total: currentTotal(),
      operatorName: 'QR棚卸'
    };

    setSaving(true);
    enqueueSave(payload);
    setSaving(false);
    closeOverlay({ queued: true });
  }

  function manualOpen() {
    if (state.scanLocked) {
      return;
    }

    showProduct(elements.productIdInput.value);
  }

  async function initializeBridge() {
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

    state.bridgeReady = true;
    loadSaveQueue();
    const hasCache = loadCatalogCache();

    if (hasCache) {
      elements.startButton.disabled = false;
      setStatus('準備完了。「カメラを起動」を押してください。', 'success');
      updateSyncIndicator();

      if (
        Date.now() - state.catalogUpdatedAt > CATALOG_MAX_AGE_MS &&
        state.pendingSaves.length === 0
      ) {
        window.setTimeout(() => refreshCatalog(), 2500);
      }
    } else {
      setStatus('初回だけ商品データを読み込んでいます。');
      await refreshCatalog({ force: true });
      setStatus('準備完了。「カメラを起動」を押してください。', 'success');
    }

    processSaveQueue();
  }

  elements.startButton.addEventListener('click', startScanner);
  elements.stopButton.addEventListener('click', stopScanner);
  elements.manualButton.addEventListener('click', manualOpen);
  elements.refreshDataButton.addEventListener('click', async () => {
    if (state.pendingSaves.length > 0) {
      setSyncState('未送信データを先に送信しています。', 'sending');
      processSaveQueue();
      return;
    }

    await refreshCatalog({ force: true });
  });
  elements.productIdInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      manualOpen();
    }
  });

  elements.closeOverlayButton.addEventListener('click', () => {
    closeOverlay();
  });

  elements.numberKeyButtons.forEach(button => {
    button.addEventListener('click', () => {
      appendEntryDigit(button.dataset.numberKey);
    });
  });
  elements.multiplyButton.addEventListener('click', appendMultiplyOperator);
  elements.entryClearButton.addEventListener('click', clearEntryValue);
  elements.entryBackspaceButton.addEventListener('click', backspaceEntryValue);
  elements.addEntryButton.addEventListener('click', () => {
    commitPendingEntry();
  });
  elements.undoButton.addEventListener('click', () => {
    state.entries.pop();
    renderCount();
  });
  elements.clearButton.addEventListener('click', () => {
    if (
      state.entries.length &&
      window.confirm('加算履歴をすべて消しますか？')
    ) {
      state.entries = [];
      elements.entryInput.value = '';
      state.entryCommitted = false;
      renderCount();
    }
  });
  elements.saveButton.addEventListener('click', saveInventory);

  window.addEventListener('online', processSaveQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      processSaveQueue();
    }
  });
  window.addEventListener('pagehide', () => {
    persistSaveQueue();
    persistCatalog();

    if (state.scanner && state.running) {
      state.scanner.stop().catch(() => {});
    }
  });

  renderCount();
  initializeBridge();
})();
