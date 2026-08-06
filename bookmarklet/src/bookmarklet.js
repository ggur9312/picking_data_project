// 쿠팡 벤더 반품(vendor-return) 처리 데이터 수집 북마크릿
//
// 목록 페이지(inbound.coupang.com)와 재고조회 API(inventory.coupang.com)가
// 서로 다른 도메인이라 직접 fetch()하면 CORS로 막힙니다. 이 북마크릿은
// 같은 스크립트를 두 번 클릭해서 씁니다:
//   1) 목록 페이지에서 클릭 -> 데이터 수집 후 재고조회 페이지를 새 창으로 열고
//      window.name에 수집한 데이터를 실어 보냄 (도메인이 바뀌어도 유지되는
//      브라우저 특성 이용, CORS와 무관)
//   2) 새로 열린 재고조회 페이지에서 다시 클릭 -> window.name에서 데이터를 읽어
//      같은 출처(same-origin)로 재고 API를 호출 (CORS 문제 없음)
//
// 모든 UI(알림/입력/결과)는 현재 문서 안에 그려지는 모달입니다. 예전처럼 별도
// 창(window.open)으로 결과를 띄우지 않기 때문에, 다른 탭을 닫아도 결과 모달의
// 복사/닫기 버튼이 죽지 않습니다.
//
// 주의: 이 파일은 build.js가 "한 줄 시작 // 주석"과 "/* */ 블록"만 제거해서 압축합니다.
// 코드가 있는 줄 끝에 // 주석을 붙이지 마세요 (특히 URL 문자열이 있는 줄).
(function () {
  'use strict';

  var CONFIG = {
    LIST_CONTAINER_ID: 'vendorReturnOrderPage',
    LIST_PAGING_URL: 'https://inbound.coupang.com/vendor-return/order/paging',
    LIST_PARAM_NAMES: [
      'isVirtualVendorReturn', 'vendorReturnWorkId', 'skuExternalId', 'skuBarcode',
      'vendorName', 'vendorReturnOrderExternalId', 'vendorReturnOrderId', 'agent',
      'status', 'start', 'end'
    ],
    LIST_FETCH_SIZE: 10000,
    MAX_LIST_PAGES: 200,
    MAX_PAYLOAD_CHARS: 1500000,
    CONFIRM_LINK_THRESHOLD: 50,
    ITEM_LIST_URL: function (orderId) {
      return 'https://inbound.coupang.com/vendor-return/order/item/paging?page=0&size=1000&pageSize=1000&isVirtualVendorReturn=false&vendorReturnOrderId=' +
        encodeURIComponent(orderId) + '&orderItemSearchStatus=';
    },
    INVENTORY_PAGE_SIZE: 20,
    INVENTORY_SEARCH_URL: function (skuId, page) {
      return 'https://inventory.coupang.com/async/inventory/search?searched=true&locationType=PICKING&zone=&fromLocation=&toLocation=&locationBarcode=&skuId=' +
        encodeURIComponent(skuId) + '&externalSkuId=&skuBarcode=&lpnId=&inventoryId=&saleableChangeType=&availableInventory=true&page=' +
        page + '&pageSize=' + CONFIG.INVENTORY_PAGE_SIZE;
    },
    INVENTORY_PAGE_URL: 'https://inventory.coupang.com/inventory/list',
    PICKING_STATUS_SUBSTR: '집품',
    FETCH_CREDENTIALS: 'include',
    DELAY_MS: 120,
    PAYLOAD_PREFIX: 'manual_hold||'
  };

  var HEADERS = ['그룹번호', '마감일시', '생성일시', '매입유형', '업체명', '상태', '운송타입', '존', '수량'];

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function parseRowSelection(input, totalRows) {
    var trimmed = (input || '').trim();
    if (trimmed === '') {
      var all = [];
      for (var i = 1; i <= totalRows; i++) all.push(i);
      return all;
    }
    var parts = trimmed.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    var result = {};
    parts.forEach(function (part) {
      var rangeMatch = part.match(/^(\d+)\s*[-~]\s*(\d+)$/);
      if (rangeMatch) {
        var a = parseInt(rangeMatch[1], 10);
        var b = parseInt(rangeMatch[2], 10);
        var lo = Math.min(a, b);
        var hi = Math.max(a, b);
        for (var n = lo; n <= hi; n++) result[n] = true;
      } else if (/^\d+$/.test(part)) {
        result[parseInt(part, 10)] = true;
      } else {
        console.warn('행 선택 파싱: 인식할 수 없는 입력, 무시함 ->', part);
      }
    });
    return Object.keys(result)
      .map(function (k) { return parseInt(k, 10); })
      .filter(function (n) { return n >= 1 && n <= totalRows; })
      .sort(function (x, y) { return x - y; });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildTsv(rows) {
    var lines = [HEADERS.join('\t')];
    rows.forEach(function (r) { lines.push(r.join('\t')); });
    return lines.join('\n');
  }

  function showToast(message) {
    var toast = document.createElement('div');
    toast.className = 'cpm-toast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#0f172a;color:#f1f5f9;' +
      'padding:14px 18px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,0.35);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'font-size:16px;line-height:1.5;max-width:380px;white-space:pre-line;opacity:0;transform:translateY(-8px);' +
      'transition:opacity 0.25s ease,transform 0.25s ease;';
    getModalRoot().appendChild(toast);
    requestAnimationFrame(function () {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      setTimeout(function () { toast.remove(); }, 300);
    }, 4500);
  }

  var MODAL_HOST_ID = 'cpm-ui-root';

  // 디자인 토큰. 색·모서리·두께·기준 폰트 크기를 여기 한 곳에 모아두었으므로,
  // 디자인을 바꾸려면 아래 두 블록만 갈아끼우면 됩니다. 개별 규칙에는 색이나
  // 크기를 직접 쓰지 마세요 — 토큰을 추가해서 var() 로 참조하세요.
  var THEME_LIGHT = [
    '--fs:16px;--ft:19px;--f1:15px;--f2:14px;--f3:13px;',
    '--r:14px;--rs:8px;--bw:1px;',
    '--pad:18px 20px;--cell:10px 14px;--head:12px 14px;',
    '--sh:0 16px 40px rgba(15,23,42,0.35);--scrim:rgba(15,23,42,0.85);',
    '--c-bg:#ffffff;--c-fg:#0f172a;--c-tt:#0f172a;--c-bd:#e2e8f0;--c-rbd:#f1f5f9;',
    '--c-sec:#334155;--c-mu:#64748b;--c-mu2:#475569;--c-fld:#f8fafc;',
    '--c-inp:#ffffff;--c-ib:#cbd5e1;--c-th:#eef2ff;--c-alt:#f8fafc;--c-hov:#eff6ff;',
    '--c-b2f:#334155;--c-b2h:#f8fafc;--c-trk:#e2e8f0;--c-cd:#e2e8f0;--c-cdf:#334155;',
    '--c-acc:#2563eb;--c-acch:#1d4ed8;--c-accf:#ffffff;--c-ring:#93c5fd;--c-ok:#16a34a;',
    '--c-bar:linear-gradient(90deg,#38bdf8,#0284c7);'
  ].join('');

  var THEME_DARK = [
    '--c-bg:#111827;--c-fg:#e2e8f0;--c-tt:#f8fafc;--c-bd:#1f2937;--c-rbd:#1f2937;',
    '--c-sec:#cbd5e1;--c-mu:#94a3b8;--c-mu2:#94a3b8;--c-fld:#0f172a;',
    '--c-inp:#0b1220;--c-ib:#334155;--c-th:#1e293b;--c-alt:#161f2e;--c-hov:#1e2b40;',
    '--c-b2f:#e2e8f0;--c-b2h:#1a2333;--c-trk:#334155;--c-cd:#1e293b;--c-cdf:#cbd5e1;'
  ].join('');

  // 모달은 Shadow DOM 안에서 렌더되므로 호스트 페이지 CSS가 선택자로 침투할 수
  // 없습니다. 다만 상속되는 속성(font-size, color, line-height 등)은 shadow 경계를
  // 넘어오므로 :host 에서 끊고, 남은 리셋은 브라우저 기본 스타일 정리용뿐입니다.
  var MODAL_CSS = [
    ':host{all:initial;display:block;' + THEME_LIGHT + '}',
    '@media (prefers-color-scheme: dark){:host{' + THEME_DARK + '}}',
    '.cpm-root{position:fixed;top:0;left:0;width:100%;height:100%;box-sizing:border-box;',
    'z-index:2147483600;display:flex;',
    'align-items:center;justify-content:center;padding:20px;background:var(--scrim);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:var(--fs);',
    'line-height:1.5;color:var(--c-fg);font-weight:400;text-align:left;letter-spacing:normal;}',
    '.cpm-root *{margin:0;padding:0;border:0;box-sizing:border-box;font:inherit;',
    'list-style:none;text-align:left;}',
    '.cpm-card{background:var(--c-bg);border:var(--bw) solid var(--c-bd);border-radius:var(--r);',
    'box-shadow:var(--sh);width:1040px;max-width:100%;max-height:86vh;',
    'display:flex;flex-direction:column;overflow:hidden;}',
    '.cpm-card.cpm-sm{width:540px;}',
    '.cpm-header{display:flex;align-items:center;gap:10px;padding:16px 20px;',
    'border-bottom:var(--bw) solid var(--c-bd);flex:0 0 auto;}',
    '.cpm-title{font-size:var(--ft);font-weight:700;margin:0;color:var(--c-tt);}',
    '.cpm-badge{background:var(--c-acc);color:var(--c-accf);font-size:var(--f2);',
    'font-weight:600;padding:3px 10px;border-radius:999px;}',
    '.cpm-body{padding:var(--pad);overflow:auto;flex:1 1 auto;}',
    '.cpm-body.cpm-flush{padding:0;}',
    '.cpm-footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;',
    'border-top:var(--bw) solid var(--c-bd);flex:0 0 auto;}',
    '.cpm-msg{margin:0;white-space:pre-line;color:var(--c-sec);}',
    '.cpm-btn{-webkit-appearance:none;appearance:none;border:none;border-radius:var(--rs);padding:9px 18px;',
    'font-size:var(--f1);font-weight:600;cursor:pointer;line-height:1.2;',
    'transition:background 0.15s ease;}',
    '.cpm-btn:focus-visible{outline:2px solid var(--c-ring);outline-offset:2px;}',
    '.cpm-btn-primary{background:var(--c-acc);color:var(--c-accf);}',
    '.cpm-btn-primary:hover{background:var(--c-acch);}',
    '.cpm-btn-secondary{background:var(--c-bg);color:var(--c-b2f);border:var(--bw) solid var(--c-ib);}',
    '.cpm-btn-secondary:hover{background:var(--c-b2h);}',
    '.cpm-btn.cpm-btn-ok,.cpm-btn.cpm-btn-ok:hover{background:var(--c-ok);color:#ffffff;border-color:var(--c-ok);}',
    '.cpm-field{margin-bottom:18px;}',
    '.cpm-field:last-child{margin-bottom:0;}',
    '.cpm-label{font-size:var(--f2);font-weight:700;color:var(--c-mu);',
    'margin-bottom:8px;letter-spacing:0.02em;}',
    '.cpm-radio{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;',
    'border:var(--bw) solid var(--c-bd);border-radius:calc(var(--rs) + 2px);margin-bottom:8px;',
    'cursor:pointer;background:var(--c-fld);}',
    '.cpm-radio:hover{border-color:var(--c-ring);}',
    '.cpm-radio input{margin:3px 0 0 0;flex:0 0 auto;}',
    '.cpm-radio b{display:block;font-size:var(--f1);color:var(--c-fg);font-weight:600;}',
    '.cpm-radio small{display:block;font-size:var(--f2);color:var(--c-mu);margin-top:2px;}',
    '.cpm-input{width:100%;padding:9px 12px;border:var(--bw) solid var(--c-ib);border-radius:var(--rs);',
    'font-size:var(--f1);background:var(--c-inp);color:var(--c-fg);}',
    '.cpm-input:focus{outline:2px solid var(--c-ring);outline-offset:-1px;}',
    '.cpm-hint{font-size:var(--f2);color:var(--c-mu);margin-top:8px;}',
    '.cpm-hint code{background:var(--c-cd);color:var(--c-cdf);border-radius:4px;padding:1px 5px;',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--f3);}',
    '.cpm-table{border-collapse:collapse;width:100%;min-width:max-content;',
    'font-size:var(--f1);}',
    '.cpm-table thead th{position:sticky;top:0;background:var(--c-th);color:var(--c-sec);text-align:left;',
    'padding:var(--head);border-bottom:var(--bw) solid var(--c-bd);white-space:nowrap;',
    'font-weight:600;z-index:1;}',
    '.cpm-table tbody td{padding:var(--cell);border-bottom:var(--bw) solid var(--c-rbd);',
    'white-space:nowrap;color:var(--c-fg);}',
    '.cpm-table tbody tr:nth-child(even){background:var(--c-alt);}',
    '.cpm-table tbody tr:hover{background:var(--c-hov);}',
    '.cpm-table td:last-child,.cpm-table th:last-child{text-align:right;}',
    '.cpm-details{margin:14px 20px 18px;}',
    '.cpm-details summary{cursor:pointer;font-size:var(--f1);color:var(--c-mu2);',
    'user-select:none;}',
    '.cpm-details summary::before{content:"\\25B8  ";}',
    '.cpm-details[open] summary::before{content:"\\25BE  ";}',
    '.cpm-textarea{width:100%;height:140px;margin-top:8px;',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--f2);',
    'padding:10px;border-radius:var(--rs);border:var(--bw) solid var(--c-ib);resize:vertical;',
    'background:var(--c-inp);color:var(--c-fg);}',
    '.cpm-bar-track{background:var(--c-trk);border-radius:6px;height:14px;overflow:hidden;',
    'margin-bottom:12px;}',
    '.cpm-bar{background:var(--c-bar);height:100%;width:0%;transition:width 0.1s ease;}',
    '.cpm-bar-pulse{animation:cpm-pulse 1.1s ease-in-out infinite;}',
    '@keyframes cpm-pulse{0%,100%{opacity:0.35;}50%{opacity:1;}}',
    '.cpm-progress-txt{font-size:var(--f1);color:var(--c-mu2);white-space:pre-line;',
    'word-break:break-all;}'
  ].join('');

  var modalDepth = 0;
  var savedOverflow = null;

  function lockScroll() {
    if (modalDepth === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    modalDepth++;
  }

  function unlockScroll() {
    modalDepth--;
    if (modalDepth <= 0) {
      modalDepth = 0;
      document.body.style.overflow = savedOverflow || '';
      savedOverflow = null;
    }
  }

  // 호스트가 조상에 zoom 이나 transform:scale 을 걸어두면 모달도 같이 확대/축소됩니다
  // (Shadow DOM 은 스타일 침투만 막을 뿐 이런 레이아웃 배율은 그대로 통과시킵니다).
  // 원인을 추측하는 대신 알려진 높이의 프로브를 실제로 그려서 재고, 어긋난 만큼
  // 역배율을 걸어 상쇄합니다. getBoundingClientRect 는 zoom 과 transform 을 모두
  // 반영하므로 원인이 무엇이든 잡힙니다.
  function measureHostScale(container) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;' +
      'visibility:hidden;pointer-events:none;';
    container.appendChild(probe);
    var rect = probe.getBoundingClientRect();
    probe.remove();
    var scale = rect.height / 100;
    if (!isFinite(scale) || scale <= 0) return 1;
    return scale;
  }

  function applyScaleCompensation(hostEl, container) {
    var scale = measureHostScale(container);
    if (Math.abs(scale - 1) < 0.02) return;
    if (scale < 0.5 || scale > 2) {
      console.warn('[북마크릿] 호스트 배율 보정 범위 밖:', scale);
      return;
    }
    console.log('[북마크릿] 호스트 배율:', scale, '-> 역배율 적용:', 1 / scale);
    hostEl.style.zoom = String(1 / scale);
  }

  var modalRoot = null;

  // 모달을 body 가 아니라 documentElement(<html>)에 붙입니다. body 나 그 하위 래퍼에
  // 걸린 zoom/transform 을 벗어나고, transform 이 걸린 조상 안에서 position:fixed 가
  // 그 조상 기준으로 잡히는 문제도 함께 피합니다.
  function getModalRoot() {
    if (modalRoot) return modalRoot;
    // 북마크릿을 같은 페이지에서 여러 번 눌러도 호스트 엘리먼트가 쌓이지 않게 재사용
    var existing = document.getElementById(MODAL_HOST_ID);
    if (existing) {
      modalRoot = existing.shadowRoot || existing;
      return modalRoot;
    }
    var hostEl = document.createElement('div');
    hostEl.id = MODAL_HOST_ID;
    hostEl.style.cssText = 'all:initial;display:block;';
    (document.documentElement || document.body).appendChild(hostEl);

    var container = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl;
    var style = document.createElement('style');
    style.textContent = MODAL_CSS;
    container.appendChild(style);

    applyScaleCompensation(hostEl, container);
    modalRoot = container;
    return modalRoot;
  }

  function openModal(options) {
    var opts = options || {};
    var buttons = opts.buttons || [];
    var dismissible = opts.dismissible !== false;

    var root = document.createElement('div');
    root.className = 'cpm-root';

    var card = document.createElement('div');
    card.className = 'cpm-card' + (opts.size === 'sm' ? ' cpm-sm' : '');

    var badgeHtml = opts.badge ? '<span class="cpm-badge">' + escapeHtml(opts.badge) + '</span>' : '';
    var buttonsHtml = buttons.map(function (b, i) {
      return '<button type="button" class="cpm-btn ' + (b.primary ? 'cpm-btn-primary' : 'cpm-btn-secondary') +
        '" data-cpm-btn="' + i + '">' + escapeHtml(b.label) + '</button>';
    }).join('');

    card.innerHTML =
      '<div class="cpm-header"><h2 class="cpm-title">' + escapeHtml(opts.title || '') + '</h2>' + badgeHtml + '</div>' +
      '<div class="cpm-body' + (opts.flush ? ' cpm-flush' : '') + '">' + (opts.bodyHtml || '') + '</div>' +
      (buttonsHtml ? '<div class="cpm-footer">' + buttonsHtml + '</div>' : '');

    root.appendChild(card);
    getModalRoot().appendChild(root);
    lockScroll();

    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      root.remove();
      unlockScroll();
    }

    function isTopMost() {
      var all = getModalRoot().querySelectorAll('.cpm-root');
      return all.length === 0 || all[all.length - 1] === root;
    }

    function onKeyDown(e) {
      if (closed || !isTopMost()) return;
      if (e.key === 'Escape' && opts.onEscape) {
        e.preventDefault();
        e.stopPropagation();
        opts.onEscape();
      } else if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        e.stopPropagation();
        close();
        if (opts.onDismiss) opts.onDismiss();
      } else if (e.key === 'Enter' && opts.onEnter) {
        e.preventDefault();
        e.stopPropagation();
        opts.onEnter();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);

    if (dismissible) {
      root.addEventListener('click', function (e) {
        if (e.target !== root) return;
        close();
        if (opts.onDismiss) opts.onDismiss();
      });
    }

    var modal = {
      root: root,
      card: card,
      close: close,
      query: function (sel) { return card.querySelector(sel); }
    };

    buttons.forEach(function (b, i) {
      var el = card.querySelector('[data-cpm-btn="' + i + '"]');
      if (!el) return;
      el.addEventListener('click', function () {
        if (b.onClick) b.onClick(modal, el);
        else close();
      });
    });

    if (opts.onReady) opts.onReady(modal);
    return modal;
  }

  function showAlert(message, title) {
    return new Promise(function (resolve) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        resolve();
      }
      openModal({
        title: title || '알림',
        size: 'sm',
        bodyHtml: '<p class="cpm-msg">' + escapeHtml(message) + '</p>',
        buttons: [{ label: '확인', primary: true, onClick: function (m) { m.close(); done(); } }],
        onDismiss: done,
        onReady: function (m) {
          var btn = m.query('.cpm-btn-primary');
          if (btn) btn.focus();
        }
      });
    });
  }

  function showConfirm(message, okLabel, cancelLabel, title) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      openModal({
        title: title || '확인',
        size: 'sm',
        bodyHtml: '<p class="cpm-msg">' + escapeHtml(message) + '</p>',
        buttons: [
          { label: cancelLabel || '취소', onClick: function (m) { m.close(); done(false); } },
          { label: okLabel || '계속', primary: true, onClick: function (m) { m.close(); done(true); } }
        ],
        onDismiss: function () { done(false); },
        onReady: function (m) {
          var btn = m.query('.cpm-btn-primary');
          if (btn) btn.focus();
        }
      });
    });
  }

  function showSessionExpiredModal(extraMessage) {
    var message = '로그인이 풀려서 수집을 중단했습니다.\n지금까지 모은 데이터는 저장하지 않았습니다.\n\n' +
      '다시 로그인한 뒤 북마크릿을 실행해 주세요.' + (extraMessage ? '\n' + extraMessage : '');
    return new Promise(function (resolve) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        resolve(null);
      }
      openModal({
        title: '로그인이 필요합니다',
        size: 'sm',
        bodyHtml: '<p class="cpm-msg">' + escapeHtml(message) + '</p>',
        buttons: [
          { label: '닫기', onClick: function (m) { m.close(); done(); } },
          {
            label: '로그인 페이지 열기',
            primary: true,
            onClick: function (m) {
              window.open(location.origin, '_blank');
              m.close();
              done();
            }
          }
        ],
        onDismiss: done
      });
    });
  }

  var SCOPE_HINT = {
    page: '행 번호는 지금 화면에 보이는 행 기준입니다.',
    all: '행 번호는 전체 페이지를 합친 순서(1페이지 1행부터) 기준입니다.'
  };

  function showCollectModal(visibleCount) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      var bodyHtml =
        '<div class="cpm-field">' +
        '<div class="cpm-label">수집 범위</div>' +
        '<label class="cpm-radio"><input type="radio" name="cpm-scope" value="page" checked>' +
        '<span><b>현재 페이지만</b><small>화면에 보이는 ' + visibleCount + '개 행만 처리합니다.</small></span></label>' +
        '<label class="cpm-radio"><input type="radio" name="cpm-scope" value="all">' +
        '<span><b>전체 페이지</b><small>지금 걸려 있는 검색 조건으로 모든 페이지를 서버에서 가져옵니다.</small></span></label>' +
        '</div>' +
        '<div class="cpm-field">' +
        '<div class="cpm-label">처리할 행 번호</div>' +
        '<input type="text" class="cpm-input" data-cpm-rows placeholder="비워두면 전체 처리">' +
        '<div class="cpm-hint">예: <code>4</code> · <code>1,3,4</code> · <code>1-3</code> · <code>1~3</code><br>' +
        '<span data-cpm-scope-hint>' + escapeHtml(SCOPE_HINT.page) + '</span></div>' +
        '</div>';

      var modal;

      function currentScope() {
        var checked = modal.query('input[name="cpm-scope"]:checked');
        return checked ? checked.value : 'page';
      }

      function submit() {
        var input = modal.query('[data-cpm-rows]');
        var value = input ? input.value : '';
        var scope = currentScope();
        modal.close();
        done({ scope: scope, selection: value });
      }

      modal = openModal({
        title: '데이터 수집',
        size: 'sm',
        bodyHtml: bodyHtml,
        buttons: [
          { label: '취소', onClick: function (m) { m.close(); done(null); } },
          { label: '수집 시작', primary: true, onClick: submit }
        ],
        onDismiss: function () { done(null); },
        onEnter: submit,
        onReady: function (m) {
          var hint = m.query('[data-cpm-scope-hint]');
          var radios = m.card.querySelectorAll('input[name="cpm-scope"]');
          for (var i = 0; i < radios.length; i++) {
            radios[i].addEventListener('change', function (e) {
              if (hint) hint.textContent = SCOPE_HINT[e.target.value] || '';
            });
          }
          var input = m.query('[data-cpm-rows]');
          if (input) input.focus();
        }
      });
    });
  }

  // 토스트만으로는 놓치기 쉬워서, 누른 버튼 자체가 잠깐 바뀌는 피드백을 함께 줍니다.
  function flashButton(btn, label) {
    if (!btn || btn.getAttribute('data-cpm-flash') === '1') return;
    var original = btn.textContent;
    btn.setAttribute('data-cpm-flash', '1');
    btn.textContent = label;
    btn.classList.add('cpm-btn-ok');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('cpm-btn-ok');
      btn.removeAttribute('data-cpm-flash');
    }, 1800);
  }

  function copyToClipboard(text, textarea, btn) {
    function selectFallback(message) {
      if (textarea) {
        textarea.focus();
        textarea.select();
      }
      showToast(message);
    }
    // execCommand('copy')는 Shadow DOM 안의 선택 영역을 복사하지 못하는 브라우저가
    // 있으므로, 폴백은 light DOM 에 임시 textarea 를 만들어서 복사합니다.
    function execCommandFallback() {
      var temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', 'readonly');
      temp.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
      document.body.appendChild(temp);
      var ok = false;
      try {
        temp.select();
        temp.setSelectionRange(0, temp.value.length);
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      temp.remove();
      if (ok) {
        flashButton(btn, '✓ 복사됨');
        showToast('✅ 클립보드에 복사되었습니다.');
        return;
      }
      if (textarea) {
        var details = textarea.closest ? textarea.closest('details') : null;
        if (details) details.open = true;
        selectFallback('자동 복사에 실패했습니다.\n텍스트가 선택되어 있으니 Ctrl+C로 복사하세요.');
      } else {
        selectFallback('자동 복사에 실패했습니다.\n"원본 데이터 (TSV) 보기"를 펼쳐 직접 복사해 주세요.');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flashButton(btn, '✓ 복사됨');
        showToast('✅ 클립보드에 복사되었습니다.');
      }, execCommandFallback);
    } else {
      execCommandFallback();
    }
  }

  function showResultModal(rows) {
    var tsv = buildTsv(rows);
    var tableRowsHtml = rows.map(function (r) {
      return '<tr>' + r.map(function (v) { return '<td>' + escapeHtml(v) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var headHtml = HEADERS.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');

    var bodyHtml =
      '<table class="cpm-table"><thead><tr>' + headHtml + '</tr></thead>' +
      '<tbody>' + tableRowsHtml + '</tbody></table>' +
      '<details class="cpm-details"><summary>원본 데이터 (TSV) 보기</summary>' +
      '<textarea class="cpm-textarea" data-cpm-tsv readonly></textarea></details>';

    var modal = openModal({
      title: '데이터 수집 결과',
      badge: rows.length + '건',
      bodyHtml: bodyHtml,
      flush: true,
      buttons: [
        { label: '닫기', onClick: function (m) { m.close(); } },
        {
          label: '📋 복사',
          primary: true,
          onClick: function (m, btn) {
            copyToClipboard(tsv, m.query('[data-cpm-tsv]'), btn);
          }
        }
      ],
      onReady: function (m) {
        var area = m.query('[data-cpm-tsv]');
        if (area) area.value = tsv;
        var btn = m.query('.cpm-btn-primary');
        if (btn) btn.focus();
      }
    });
    return modal;
  }

  // 진행률 모달. 취소 버튼과 Esc 로 언제든 중단할 수 있고, 취소하면 진행 중인
  // 요청을 AbortController 로 즉시 끊습니다. 배경 클릭으로는 닫히지 않습니다 —
  // 오래 걸리는 작업이 오클릭 한 번에 날아가면 안 되기 때문입니다.
  function createProgressOverlay(title) {
    var cancelled = false;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var modal = null;

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          console.warn('요청 중단 실패:', err);
        }
      }
      if (modal) modal.close();
    }

    modal = openModal({
      title: title,
      size: 'sm',
      dismissible: false,
      bodyHtml: '<div class="cpm-bar-track"><div class="cpm-bar" data-cpm-bar></div></div>' +
        '<div class="cpm-progress-txt" data-cpm-txt>준비 중...</div>',
      buttons: [{ label: '취소', onClick: cancel }],
      onEscape: cancel
    });

    var bar = modal.query('[data-cpm-bar]');
    var txt = modal.query('[data-cpm-txt]');

    return {
      update: function (current, total, label) {
        if (cancelled) return;
        var pct = total > 0 ? Math.floor((current / total) * 100) : 0;
        bar.className = 'cpm-bar';
        bar.style.width = pct + '%';
        txt.textContent = '진행률: ' + pct + '% (' + current + '/' + total + ')\n현재 처리: ' + label;
      },
      status: function (label) {
        if (cancelled) return;
        bar.className = 'cpm-bar cpm-bar-pulse';
        bar.style.width = '100%';
        txt.textContent = label;
      },
      isCancelled: function () {
        return cancelled;
      },
      signal: controller ? controller.signal : undefined,
      remove: function () {
        modal.close();
      }
    };
  }

  function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
  }

  function sessionError(url) {
    var err = new Error('로그인이 풀렸습니다 (세션 만료): ' + url);
    err.sessionExpired = true;
    return err;
  }

  function isSessionExpired(err) {
    return !!err && err.sessionExpired === true;
  }

  // 세션이 끊기면 서버는 보통 302로 로그인 페이지에 보내는데, fetch 는 기본이
  // redirect:'follow' 라 최종 응답이 "200 + 로그인 HTML" 로 돌아옵니다. resp.ok 만
  // 봐서는 정상 응답과 구분되지 않으므로 리다이렉트 여부와 상태 코드를 함께 봅니다.
  // 경로 이름(/login 등)에 의존하지 않아 어드민 구조가 바뀌어도 동작하고,
  // 슬래시 정규화처럼 같은 경로로 되돌아오는 리다이렉트에는 반응하지 않습니다.
  function checkSession(resp, requestedUrl) {
    if (resp.status === 401 || resp.status === 403) throw sessionError(requestedUrl);
    if (resp.redirected) {
      var from = '';
      var to = '';
      try {
        from = new URL(requestedUrl, document.baseURI).pathname;
        to = new URL(resp.url).pathname;
      } catch (err) {
        return resp;
      }
      if (from && to && from !== to) throw sessionError(requestedUrl);
    }
    return resp;
  }

  // 리다이렉트 없이 로그인 화면을 그대로 렌더(forward)하는 서버도 있습니다.
  function looksLikeLoginHtml(text) {
    return /<input[^>]+type\s*=\s*["']?password/i.test(text);
  }

  function fetchText(url, signal) {
    return fetch(url, { credentials: CONFIG.FETCH_CREDENTIALS, signal: signal }).then(function (resp) {
      checkSession(resp, url);
      if (!resp.ok) throw new Error('요청 실패 (' + resp.status + '): ' + url);
      return resp.text();
    }).then(function (text) {
      if (looksLikeLoginHtml(text)) throw sessionError(url);
      return text;
    });
  }

  function parseHtml(text) {
    return new DOMParser().parseFromString(text, 'text/html');
  }

  function getDataRow(table) {
    var trs = table.querySelectorAll('tr');
    return trs[1] || trs[0] || null;
  }

  function cellText(row, idx) {
    if (!row) return null;
    var cells = row.querySelectorAll('td');
    return cells[idx] ? cells[idx].textContent.trim() : null;
  }

  function cellTextFromEnd(row, fromEnd) {
    if (!row) return null;
    var cells = row.querySelectorAll('td');
    var idx = cells.length - fromEnd;
    return cells[idx] ? cells[idx].textContent.trim() : null;
  }

  function extractOrderIdFromUrl(url) {
    var m = url.match(/vendorReturnOrderId=(\d+)/);
    return m ? m[1] : null;
  }

  function extractOrderIdFromHtml(html) {
    var m = html.match(/vendorReturnOrderId\s*=\s*["']?(\d+)/);
    return m ? m[1] : null;
  }

  function getDetailRows(detailHtml) {
    var doc = parseHtml(detailHtml);
    var tables = doc.querySelectorAll('table');
    if (tables.length < 2) {
      throw new Error('상세 페이지에서 테이블 2개를 찾지 못함 (찾은 개수: ' + tables.length + ')');
    }
    return { row1: getDataRow(tables[0]), row2: getDataRow(tables[1]) };
  }

  function scrapeCommonData(row1, row2) {
    var groupNo = cellText(row1, 0);
    var purchaseType = cellText(row1, 3);
    var createdAt = cellText(row1, 5);
    var status = cellText(row1, 7);
    var vendorName = cellText(row2, 0);
    var transportType = cellTextFromEnd(row2, 3);
    var deadline = purchaseType === '쿠팡상품' ? cellTextFromEnd(row2, 4) : cellText(row1, 6);
    return [groupNo, deadline, createdAt, purchaseType, vendorName, status, transportType];
  }

  function scrapeSkuIds(itemListHtml) {
    var doc = parseHtml(itemListHtml);
    var table = doc.querySelector('table');
    if (!table) return [];
    var rows = table.querySelectorAll('tbody tr, tr');
    var results = [];
    rows.forEach(function (row) {
      var tds = row.querySelectorAll('td');
      if (tds.length < 10) return;
      var skuId = tds[0].textContent.trim().replace(/,/g, '');
      var status = tds[9].textContent.trim();
      if (skuId && /^\d+$/.test(skuId) && status.indexOf(CONFIG.PICKING_STATUS_SUBSTR) !== -1) {
        results.push(skuId);
      }
    });
    return results;
  }

  function processLink(link, signal) {
    return fetchText(link, signal).then(function (detailHtml) {
      var detailRows = getDetailRows(detailHtml);
      var orderId = cellText(detailRows.row1, 2);
      if (!orderId) orderId = extractOrderIdFromUrl(link);
      if (!orderId) orderId = extractOrderIdFromHtml(detailHtml);
      if (!orderId) throw new Error('vendorReturnOrderId를 찾지 못함: ' + link);
      var common = scrapeCommonData(detailRows.row1, detailRows.row2);
      var commonStr = common.join('\t');
      return fetchText(CONFIG.ITEM_LIST_URL(orderId), signal).then(function (itemHtml) {
        var skuIds = scrapeSkuIds(itemHtml);
        return skuIds.map(function (skuId) { return skuId + '||' + commonStr; });
      });
    });
  }

  function absoluteHref(anchor) {
    if (!anchor) return '';
    var raw = anchor.getAttribute('href');
    if (!raw || /^javascript:/i.test(raw) || raw === '#') return '';
    try {
      return new URL(raw, document.baseURI).href;
    } catch (err) {
      return anchor.href || '';
    }
  }

  function extractRowHrefs(root) {
    var trs = root.querySelectorAll('table tbody tr');
    var hrefs = [];
    for (var i = 0; i < trs.length; i++) {
      var cells = trs[i].cells;
      var cell = cells && cells.length > 1 ? cells[1] : null;
      hrefs.push(cell ? absoluteHref(cell.querySelector('a')) : '');
    }
    return { rowCount: trs.length, hrefs: hrefs };
  }

  function readFieldValue(name) {
    var selector = 'input[name="' + name + '"], select[name="' + name + '"], textarea[name="' + name + '"]';
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      var type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked && el.value !== '') return el.value;
        continue;
      }
      var value = (el.value == null ? '' : String(el.value)).trim();
      if (value !== '') return value;
    }
    return '';
  }

  function readListParams() {
    return CONFIG.LIST_PARAM_NAMES.map(function (name) {
      return encodeURIComponent(name) + '=' + encodeURIComponent(readFieldValue(name));
    }).join('&');
  }

  function fetchAllListHrefs(overlay) {
    var params = readListParams();
    console.log('[북마크릿] 목록 전체 조회 파라미터:', params);
    var hrefs = [];
    var seen = {};
    var linkCount = 0;

    // 서버가 size를 그대로 받아주면 0페이지 한 번으로 끝나고, 몰래 상한(예: 10건)으로
    // 잘라서 주면 다음 페이지가 계속 나옵니다. "새 링크가 하나도 없는 페이지"를
    // 종료 조건으로 삼으면 두 경우 모두 같은 코드로 처리됩니다.
    function loop(page) {
      if (overlay && overlay.isCancelled()) return Promise.resolve(hrefs);
      var url = CONFIG.LIST_PAGING_URL + '?' + params + '&page=' + page + '&size=' + CONFIG.LIST_FETCH_SIZE;
      if (overlay) overlay.status('목록 ' + (page + 1) + '페이지 조회 중...\n지금까지 ' + linkCount + '건');
      return fetchText(url, overlay ? overlay.signal : undefined).then(function (html) {
        var found = extractRowHrefs(parseHtml(html));
        var pageHrefs = [];
        var newCount = 0;
        found.hrefs.forEach(function (href) {
          if (href === '' || seen[href]) {
            pageHrefs.push('');
            return;
          }
          seen[href] = true;
          pageHrefs.push(href);
          newCount++;
        });
        if (found.rowCount === 0 || newCount === 0) return hrefs;
        hrefs.push.apply(hrefs, pageHrefs);
        linkCount += newCount;
        if (page + 1 >= CONFIG.MAX_LIST_PAGES) {
          console.warn('[북마크릿] 최대 페이지 수(' + CONFIG.MAX_LIST_PAGES + ')에 도달해 중단합니다.');
          return hrefs;
        }
        return sleep(CONFIG.DELAY_MS).then(function () { return loop(page + 1); });
      });
    }

    return loop(0);
  }

  function collectAllPages(visibleCount) {
    var overlay = createProgressOverlay('목록 전체 페이지 수집중');
    return fetchAllListHrefs(overlay).then(function (hrefs) {
      if (overlay.isCancelled()) {
        showToast('조회를 취소했습니다.');
        return null;
      }
      overlay.remove();
      var found = hrefs.filter(function (h) { return h !== ''; }).length;
      if (found === 0) {
        return showAlert('전체 페이지 조회 결과가 비어 있습니다.\n\n검색 조건을 확인하거나 "현재 페이지만" 모드를 사용해 주세요.\n(개발자 도구 콘솔에 조회 파라미터가 기록되어 있습니다)')
          .then(function () { return null; });
      }
      if (visibleCount > 0 && hrefs.length < visibleCount) {
        return showConfirm('전체 조회로 ' + hrefs.length + '건을 가져왔는데, 화면에 보이는 행(' + visibleCount + '건)보다 적습니다.\n검색 조건이 제대로 전달되지 않았을 수 있습니다.\n\n계속 진행할까요?', '계속 진행', '취소')
          .then(function (ok) { return ok ? hrefs : null; });
      }
      return hrefs;
    }).catch(function (err) {
      if (overlay.isCancelled() || isAbortError(err)) {
        overlay.remove();
        showToast('조회를 취소했습니다.');
        return null;
      }
      overlay.remove();
      if (isSessionExpired(err)) return showSessionExpiredModal();
      console.error('목록 전체 조회 실패:', err);
      return showAlert('목록 전체 조회에 실패했습니다.\n' + err.message + '\n\n"현재 페이지만" 모드를 사용해 주세요.')
        .then(function () { return null; });
    });
  }

  function formatDuration(seconds) {
    var total = Math.max(1, Math.round(seconds));
    var min = Math.floor(total / 60);
    var sec = total % 60;
    if (min === 0) return sec + '초';
    return min + '분 ' + sec + '초';
  }

  function confirmWorkload(links) {
    if (links.length < CONFIG.CONFIRM_LINK_THRESHOLD) return Promise.resolve(true);
    var estimate = links.length * (CONFIG.DELAY_MS + 700) / 1000;
    return showConfirm(links.length + '건을 처리합니다.\n예상 소요 시간은 약 ' + formatDuration(estimate) + '입니다.\n\n진행하는 동안 이 탭을 닫거나 이동하지 마세요.\n계속할까요?', '계속 진행', '취소');
  }

  function openInventoryTab(payload, count) {
    var winName = 'coupangInv_' + Date.now();
    var win = window.open(CONFIG.INVENTORY_PAGE_URL, winName);
    if (!win) {
      return showAlert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
    }
    win.name = payload;
    showToast('✅ ' + count + '건 수집 완료\n새 탭에서 이 북마크릿을 한 번 더 눌러주세요.');
    return Promise.resolve();
  }

  function processLinks(links) {
    var overlay = createProgressOverlay('데이터 수집중');
    var lines = [];
    var pipeline = Promise.resolve();
    links.forEach(function (link, idx) {
      pipeline = pipeline.then(function () {
        if (overlay.isCancelled()) return null;
        overlay.update(idx + 1, links.length, link);
        return processLink(link, overlay.signal).then(function (newLines) {
          lines = lines.concat(newLines);
        }).catch(function (err) {
          if (isSessionExpired(err)) throw err;
          if (overlay.isCancelled() || isAbortError(err)) return;
          console.error('링크 처리 실패:', link, err);
        }).then(function () {
          if (overlay.isCancelled()) return null;
          return sleep(CONFIG.DELAY_MS);
        });
      });
    });

    return pipeline.then(function () {
      if (overlay.isCancelled()) {
        showToast('수집을 취소했습니다.');
        return null;
      }
      overlay.remove();
      if (lines.length === 0) {
        return showAlert('수집된 데이터가 없습니다. (집품중/집품대기 상태의 아이템이 없을 수 있습니다)');
      }
      var payload = CONFIG.PAYLOAD_PREFIX + lines.join('\n');
      if (payload.length > CONFIG.MAX_PAYLOAD_CHARS) {
        return showConfirm('수집 데이터가 매우 큽니다 (' + payload.length + '자).\n브라우저에 따라 다음 탭으로 전달되지 않을 수 있습니다.\n\n계속할까요?', '계속 진행', '취소')
          .then(function (ok) { return ok ? openInventoryTab(payload, lines.length) : null; });
      }
      return openInventoryTab(payload, lines.length);
    }).catch(function (err) {
      overlay.remove();
      if (overlay.isCancelled() || isAbortError(err)) {
        showToast('수집을 취소했습니다.');
        return null;
      }
      if (isSessionExpired(err)) return showSessionExpiredModal();
      throw err;
    });
  }

  function runStep1() {
    var container = document.querySelector('#' + CONFIG.LIST_CONTAINER_ID);
    var visibleRows = container.querySelectorAll('table tbody tr');

    return showCollectModal(visibleRows.length).then(function (choice) {
      if (!choice) return null;
      if (choice.scope === 'all') {
        return collectAllPages(visibleRows.length).then(function (hrefs) {
          return hrefs ? { hrefs: hrefs, selection: choice.selection } : null;
        });
      }
      if (visibleRows.length === 0) {
        return showAlert('화면에 표시된 행이 없습니다.').then(function () { return null; });
      }
      var hrefs = [];
      for (var i = 0; i < visibleRows.length; i++) {
        var cells = visibleRows[i].cells;
        var cell = cells && cells.length > 1 ? cells[1] : null;
        hrefs.push(cell ? absoluteHref(cell.querySelector('a')) : '');
      }
      return { hrefs: hrefs, selection: choice.selection };
    }).then(function (ctx) {
      if (!ctx) return null;
      var selected = parseRowSelection(ctx.selection, ctx.hrefs.length);
      if (selected.length === 0) {
        return showAlert('처리할 행이 없습니다.');
      }
      var links = [];
      selected.forEach(function (n) {
        if (ctx.hrefs[n - 1]) links.push(ctx.hrefs[n - 1]);
      });
      if (links.length === 0) {
        return showAlert('수집할 링크가 없습니다.');
      }
      return confirmWorkload(links).then(function (ok) {
        return ok ? processLinks(links) : null;
      });
    });
  }

  function zoneFromLocationBarcode(barcode) {
    if (!barcode) return '';
    var segments = barcode.split('-');
    if (segments[1] && /^\d/.test(segments[1])) {
      return segments[1].substring(0, 3);
    }
    return barcode;
  }

  function fetchInventoryAllPages(skuId, signal) {
    var results = [];
    function loop(page) {
      var url = CONFIG.INVENTORY_SEARCH_URL(skuId, page);
      return fetch(url, { credentials: 'same-origin', signal: signal }).then(function (resp) {
        checkSession(resp, url);
        if (!resp.ok) throw new Error('요청 실패 (' + resp.status + ')');
        return resp.text();
      }).then(function (text) {
        if (looksLikeLoginHtml(text)) throw sessionError(url);
        return JSON.parse(text);
      }).then(function (json) {
        if (!json || !json.success || !json.result || !Array.isArray(json.result.content)) {
          return results;
        }
        json.result.content.forEach(function (row) {
          var qty = Number(row.allocatedQuantity) || 0;
          if (row.locationType === 'PICKING' && qty > 0) {
            results.push({ zone: zoneFromLocationBarcode(row.locationBarcode), qty: qty });
          }
        });
        if (json.result.last === true || json.result.content.length === 0) {
          return results;
        }
        return loop(page + 1);
      });
    }
    return loop(0);
  }

  function runStep2() {
    var name = window.name;
    if (!name || name.indexOf(CONFIG.PAYLOAD_PREFIX) !== 0) {
      return showAlert('데이터를 찾을 수 없습니다. 목록 페이지에서 이 북마크릿을 먼저 실행해 주세요.');
    }
    window.name = '';
    var body = name.slice(CONFIG.PAYLOAD_PREFIX.length);
    var lines = body.split('\n').filter(function (l) { return l.indexOf('||') !== -1; });
    if (lines.length === 0) {
      return showAlert('처리할 데이터가 없습니다.');
    }

    var overlay = createProgressOverlay('데이터 수집중');

    // 중단하면 수집 결과를 버리므로, 1단계부터 다시 하지 않아도 되도록
    // window.name 에 실려 온 원본 데이터를 되돌려 놓습니다.
    function restorePayload() {
      window.name = name;
    }

    function cancelledStep2() {
      restorePayload();
      showToast('조회를 취소했습니다.\n이 탭에서 북마크릿을 다시 누르면 처음부터 조회합니다.');
      return null;
    }

    function sessionExpiredStep2() {
      restorePayload();
      return showSessionExpiredModal('1단계 수집 결과는 이 탭에 남아 있으니, 로그인 후 여기서 북마크릿만 다시 누르면 됩니다.');
    }

    var rawRecords = [];
    var pipeline = Promise.resolve();
    lines.forEach(function (line, idx) {
      var parts = line.split('||');
      var skuId = parts[0];
      var common = (parts[1] || '').split('\t');
      pipeline = pipeline.then(function () {
        if (overlay.isCancelled()) return null;
        overlay.update(idx + 1, lines.length, skuId);
        return fetchInventoryAllPages(skuId, overlay.signal).then(function (entries) {
          entries.forEach(function (entry) {
            rawRecords.push({ groupNo: common[0], rest: common.slice(1), zone: entry.zone, qty: entry.qty });
          });
        }).catch(function (err) {
          if (isSessionExpired(err)) throw err;
          if (overlay.isCancelled() || isAbortError(err)) return;
          console.error('skuId=' + skuId + ' 재고 조회 실패:', err);
        }).then(function () {
          if (overlay.isCancelled()) return null;
          return sleep(CONFIG.DELAY_MS);
        });
      });
    });

    return pipeline.then(function () {
      if (overlay.isCancelled()) return cancelledStep2();
      overlay.remove();
      if (rawRecords.length === 0) {
        return showAlert('수집된 데이터가 없습니다. (수량이 0이거나 일치하는 항목이 없음)');
      }
      var aggregated = {};
      rawRecords.forEach(function (rec) {
        var key = rec.groupNo + '_' + rec.zone;
        if (!aggregated[key]) aggregated[key] = { groupNo: rec.groupNo, rest: rec.rest, zone: rec.zone, qty: 0 };
        aggregated[key].qty += rec.qty;
      });
      var items = Object.keys(aggregated).map(function (k) { return aggregated[k]; });
      items.sort(function (a, b) { return a.zone.localeCompare(b.zone, undefined, { numeric: true, sensitivity: 'base' }); });
      var rows = items.map(function (item) {
        var rest = item.rest.map(function (val, idx) {
          if (idx === 0 || idx === 1) return String(val).split(' ')[0];
          return val;
        });
        return [item.groupNo].concat(rest).concat([item.zone, item.qty]);
      });
      showResultModal(rows);
      return null;
    }).catch(function (err) {
      overlay.remove();
      if (overlay.isCancelled() || isAbortError(err)) return cancelledStep2();
      if (isSessionExpired(err)) return sessionExpiredStep2();
      throw err;
    });
  }

  function main() {
    var task = document.querySelector('#' + CONFIG.LIST_CONTAINER_ID) ? runStep1() : runStep2();
    if (task && task.catch) {
      task.catch(function (err) {
        if (isSessionExpired(err)) return showSessionExpiredModal();
        console.error(err);
        return showAlert('오류 발생: ' + err.message);
      });
    }
  }

  main();
})();
