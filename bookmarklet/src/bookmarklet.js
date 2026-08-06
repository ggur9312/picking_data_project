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

  var HEADERS = ['그룹번호', '마감일자', '생성일자', '매입유형', '업체명', '상태', '운송타입', '존', '수량'];

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
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#0f172a;color:#f1f5f9;' +
      'padding:14px 18px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,0.35);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'font-size:14px;line-height:1.5;max-width:340px;white-space:pre-line;opacity:0;transform:translateY(-8px);' +
      'transition:opacity 0.25s ease,transform 0.25s ease;';
    document.body.appendChild(toast);
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

  var MODAL_STYLE_ID = 'cpm-style';

  var MODAL_CSS = [
    '.cpm-root{position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483600;display:flex;',
    'align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,0.85);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;',
    'line-height:1.5;color:#0f172a;font-weight:400;text-align:left;letter-spacing:normal;}',
    '.cpm-root *{margin:0;padding:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;',
    'font-style:normal;text-align:left;text-decoration:none;text-transform:none;text-indent:0;',
    'letter-spacing:normal;word-spacing:normal;list-style:none;box-shadow:none;float:none;clear:none;',
    'position:static;top:auto;right:auto;bottom:auto;left:auto;width:auto;height:auto;min-width:0;',
    'min-height:0;max-width:none;max-height:none;opacity:1;visibility:visible;transform:none;',
    'vertical-align:baseline;box-sizing:border-box;border-radius:0;border-collapse:collapse;',
    'border-spacing:0;white-space:normal;}',
    '.cpm-card{background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;',
    'box-shadow:0 16px 40px rgba(15,23,42,0.35);width:960px;max-width:100%;max-height:86vh;',
    'display:flex;flex-direction:column;overflow:hidden;}',
    '.cpm-card.cpm-sm{width:480px;}',
    '.cpm-header{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #e2e8f0;flex:0 0 auto;}',
    '.cpm-title{font-size:16px;font-weight:700;margin:0;color:#0f172a;}',
    '.cpm-badge{background:#2563eb;color:#fff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;}',
    '.cpm-body{padding:18px 20px;overflow:auto;flex:1 1 auto;}',
    '.cpm-body.cpm-flush{padding:0;}',
    '.cpm-footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #e2e8f0;flex:0 0 auto;}',
    '.cpm-msg{margin:0;white-space:pre-line;color:#334155;}',
    '.cpm-btn{-webkit-appearance:none;appearance:none;border:none;border-radius:8px;padding:9px 18px;',
    'font-size:13px;font-weight:600;cursor:pointer;line-height:1.2;transition:background 0.15s ease;}',
    '.cpm-btn-primary{background:#2563eb;color:#ffffff;}',
    '.cpm-btn-primary:hover{background:#1d4ed8;}',
    '.cpm-btn-secondary{background:#ffffff;color:#334155;border:1px solid #cbd5e1;}',
    '.cpm-btn-secondary:hover{background:#f8fafc;}',
    '.cpm-field{margin-bottom:18px;}',
    '.cpm-field:last-child{margin-bottom:0;}',
    '.cpm-label{font-size:12px;font-weight:700;color:#64748b;margin-bottom:8px;letter-spacing:0.02em;}',
    '.cpm-radio{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid #e2e8f0;',
    'border-radius:10px;margin-bottom:8px;cursor:pointer;background:#f8fafc;}',
    '.cpm-radio:hover{border-color:#93c5fd;}',
    '.cpm-radio input{margin:3px 0 0 0;flex:0 0 auto;}',
    '.cpm-radio b{display:block;font-size:13px;color:#0f172a;font-weight:600;}',
    '.cpm-radio small{display:block;font-size:12px;color:#64748b;margin-top:2px;}',
    '.cpm-input{width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;',
    'background:#ffffff;color:#0f172a;}',
    '.cpm-input:focus{outline:2px solid #93c5fd;outline-offset:-1px;}',
    '.cpm-hint{font-size:12px;color:#64748b;margin-top:8px;}',
    '.cpm-hint code{background:#e2e8f0;color:#334155;border-radius:4px;padding:1px 5px;',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}',
    '.cpm-table{display:table;border-collapse:collapse;width:100%;font-size:13px;}',
    '.cpm-table thead{display:table-header-group;}',
    '.cpm-table tbody{display:table-row-group;}',
    '.cpm-table tr{display:table-row;}',
    '.cpm-table th,.cpm-table td{display:table-cell;}',
    '.cpm-table thead th{position:sticky;top:0;background:#eef2ff;color:#334155;text-align:left;',
    'padding:10px 12px;border-bottom:1px solid #e2e8f0;white-space:nowrap;font-weight:600;z-index:1;}',
    '.cpm-table tbody td{padding:8px 12px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#0f172a;}',
    '.cpm-table tbody tr:nth-child(even){background:#f8fafc;}',
    '.cpm-table tbody tr:hover{background:#eff6ff;}',
    '.cpm-table td:last-child,.cpm-table th:last-child{text-align:right;}',
    '.cpm-details{margin:14px 20px 18px;}',
    '.cpm-details summary{cursor:pointer;font-size:13px;color:#475569;user-select:none;}',
    '.cpm-details summary::before{content:"\\25B8  ";}',
    '.cpm-details[open] summary::before{content:"\\25BE  ";}',
    '.cpm-textarea{width:100%;height:140px;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
    'font-size:12px;padding:10px;border-radius:8px;border:1px solid #cbd5e1;resize:vertical;',
    'background:#ffffff;color:#0f172a;}',
    '.cpm-bar-track{background:#e2e8f0;border-radius:6px;height:14px;overflow:hidden;margin-bottom:12px;}',
    '.cpm-bar{background:linear-gradient(90deg,#38bdf8,#0284c7);height:100%;width:0%;transition:width 0.1s ease;}',
    '.cpm-bar-pulse{animation:cpm-pulse 1.1s ease-in-out infinite;}',
    '@keyframes cpm-pulse{0%,100%{opacity:0.35;}50%{opacity:1;}}',
    '.cpm-progress-txt{font-size:13px;color:#475569;white-space:pre-line;word-break:break-all;}',
    '@media (prefers-color-scheme: dark){',
    '.cpm-root{color:#e2e8f0;}',
    '.cpm-card{background:#111827;border-color:#1f2937;}',
    '.cpm-header,.cpm-footer{border-color:#1f2937;}',
    '.cpm-title{color:#f8fafc;}',
    '.cpm-msg{color:#cbd5e1;}',
    '.cpm-btn-secondary{background:#111827;color:#e2e8f0;border-color:#334155;}',
    '.cpm-btn-secondary:hover{background:#1a2333;}',
    '.cpm-label{color:#94a3b8;}',
    '.cpm-radio{background:#0f172a;border-color:#1f2937;}',
    '.cpm-radio b{color:#f1f5f9;}',
    '.cpm-radio small{color:#94a3b8;}',
    '.cpm-input,.cpm-textarea{background:#0b1220;color:#e2e8f0;border-color:#334155;}',
    '.cpm-hint{color:#94a3b8;}',
    '.cpm-hint code{background:#1e293b;color:#cbd5e1;}',
    '.cpm-table thead th{background:#1e293b;color:#cbd5e1;border-color:#1f2937;}',
    '.cpm-table tbody td{border-color:#1f2937;color:#e2e8f0;}',
    '.cpm-table tbody tr:nth-child(even){background:#161f2e;}',
    '.cpm-table tbody tr:hover{background:#1e2b40;}',
    '.cpm-details summary{color:#94a3b8;}',
    '.cpm-bar-track{background:#334155;}',
    '.cpm-progress-txt{color:#94a3b8;}',
    '}'
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

  function injectModalStyles() {
    if (document.getElementById(MODAL_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = MODAL_STYLE_ID;
    style.textContent = MODAL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function openModal(options) {
    injectModalStyles();
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
    document.body.appendChild(root);
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
      var all = document.querySelectorAll('.cpm-root');
      return all.length === 0 || all[all.length - 1] === root;
    }

    function onKeyDown(e) {
      if (closed || !isTopMost()) return;
      if (e.key === 'Escape' && dismissible) {
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
        if (b.onClick) b.onClick(modal);
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

  function copyToClipboard(text, textarea) {
    function selectFallback(message) {
      if (textarea) {
        textarea.focus();
        textarea.select();
      }
      showToast(message);
    }
    function execCommandFallback() {
      if (!textarea) {
        selectFallback('자동 복사에 실패했습니다.\n"원본 데이터 (TSV) 보기"를 펼쳐 직접 복사해 주세요.');
        return;
      }
      var details = textarea.closest ? textarea.closest('details') : null;
      if (details) details.open = true;
      textarea.focus();
      textarea.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      if (ok) showToast('✅ 클립보드에 복사되었습니다.');
      else selectFallback('자동 복사에 실패했습니다.\n텍스트가 선택되어 있으니 Ctrl+C로 복사하세요.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
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
          onClick: function (m) {
            copyToClipboard(tsv, m.query('[data-cpm-tsv]'));
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

  function createProgressOverlay(title) {
    injectModalStyles();
    var overlay = document.createElement('div');
    overlay.className = 'cpm-root';
    var card = document.createElement('div');
    card.className = 'cpm-card cpm-sm';
    card.innerHTML = '<div class="cpm-header"><h2 class="cpm-title">' + escapeHtml(title) + '</h2></div>' +
      '<div class="cpm-body">' +
      '<div class="cpm-bar-track"><div class="cpm-bar" data-cpm-bar></div></div>' +
      '<div class="cpm-progress-txt" data-cpm-txt>준비 중...</div>' +
      '</div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    lockScroll();
    var bar = card.querySelector('[data-cpm-bar]');
    var txt = card.querySelector('[data-cpm-txt]');
    var removed = false;
    return {
      update: function (current, total, label) {
        var pct = total > 0 ? Math.floor((current / total) * 100) : 0;
        bar.className = 'cpm-bar';
        bar.style.width = pct + '%';
        txt.textContent = '진행률: ' + pct + '% (' + current + '/' + total + ')\n현재 처리: ' + label;
      },
      status: function (label) {
        bar.className = 'cpm-bar cpm-bar-pulse';
        bar.style.width = '100%';
        txt.textContent = label;
      },
      remove: function () {
        if (removed) return;
        removed = true;
        overlay.remove();
        unlockScroll();
      }
    };
  }

  function fetchText(url) {
    return fetch(url, { credentials: CONFIG.FETCH_CREDENTIALS }).then(function (resp) {
      if (!resp.ok) throw new Error('요청 실패 (' + resp.status + '): ' + url);
      return resp.text();
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

  function processLink(link) {
    return fetchText(link).then(function (detailHtml) {
      var detailRows = getDetailRows(detailHtml);
      var orderId = cellText(detailRows.row1, 2);
      if (!orderId) orderId = extractOrderIdFromUrl(link);
      if (!orderId) orderId = extractOrderIdFromHtml(detailHtml);
      if (!orderId) throw new Error('vendorReturnOrderId를 찾지 못함: ' + link);
      var common = scrapeCommonData(detailRows.row1, detailRows.row2);
      var commonStr = common.join('\t');
      return fetchText(CONFIG.ITEM_LIST_URL(orderId)).then(function (itemHtml) {
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
      var url = CONFIG.LIST_PAGING_URL + '?' + params + '&page=' + page + '&size=' + CONFIG.LIST_FETCH_SIZE;
      if (overlay) overlay.status('목록 ' + (page + 1) + '페이지 조회 중...\n지금까지 ' + linkCount + '건');
      return fetchText(url).then(function (html) {
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
      overlay.remove();
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
        overlay.update(idx + 1, links.length, link);
        return processLink(link).then(function (newLines) {
          lines = lines.concat(newLines);
        }).catch(function (err) {
          console.error('링크 처리 실패:', link, err);
        }).then(function () { return sleep(CONFIG.DELAY_MS); });
      });
    });

    return pipeline.then(function () {
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

  function fetchInventoryAllPages(skuId) {
    var results = [];
    function loop(page) {
      return fetch(CONFIG.INVENTORY_SEARCH_URL(skuId, page), { credentials: 'same-origin' }).then(function (resp) {
        if (!resp.ok) throw new Error('요청 실패 (' + resp.status + ')');
        return resp.json();
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
    var rawRecords = [];
    var pipeline = Promise.resolve();
    lines.forEach(function (line, idx) {
      var parts = line.split('||');
      var skuId = parts[0];
      var common = (parts[1] || '').split('\t');
      pipeline = pipeline.then(function () {
        overlay.update(idx + 1, lines.length, skuId);
        return fetchInventoryAllPages(skuId).then(function (entries) {
          entries.forEach(function (entry) {
            rawRecords.push({ groupNo: common[0], rest: common.slice(1), zone: entry.zone, qty: entry.qty });
          });
        }).catch(function (err) {
          console.error('skuId=' + skuId + ' 재고 조회 실패:', err);
        }).then(function () { return sleep(CONFIG.DELAY_MS); });
      });
    });

    return pipeline.then(function () {
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
      throw err;
    });
  }

  function main() {
    var task = document.querySelector('#' + CONFIG.LIST_CONTAINER_ID) ? runStep1() : runStep2();
    if (task && task.catch) {
      task.catch(function (err) {
        console.error(err);
        showAlert('오류 발생: ' + err.message);
      });
    }
  }

  main();
})();
