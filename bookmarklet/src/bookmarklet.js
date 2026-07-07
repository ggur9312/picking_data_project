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
// 주의: 이 파일은 build.js가 "한 줄 시작 // 주석"과 "/* */ 블록"만 제거해서 압축합니다.
// 코드가 있는 줄 끝에 // 주석을 붙이지 마세요 (특히 URL 문자열이 있는 줄).
(function () {
  'use strict';

  var CONFIG = {
    LIST_CONTAINER_ID: 'vendorReturnOrderPage',
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

  function renderPopup(rows) {
    var tsv = buildTsv(rows);
    var win = window.open('', '_blank', 'width=900,height=600');
    if (!win) {
      alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
      return;
    }
    var tableRowsHtml = rows.map(function (r) {
      return '<tr>' + r.map(function (v) { return '<td>' + escapeHtml(v) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var headHtml = HEADERS.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>반품 데이터 수집 결과</title>' +
      '<style>' +
      'body{font-family:sans-serif;margin:12px;}' +
      'textarea{width:100%;height:160px;box-sizing:border-box;margin-bottom:8px;}' +
      'table{border-collapse:collapse;width:100%;font-size:12px;}' +
      'th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;white-space:nowrap;}' +
      'th{background:#f2f2f2;}' +
      'button{margin-bottom:8px;padding:6px 12px;cursor:pointer;}' +
      '</style></head><body>' +
      '<div>총 ' + rows.length + '건 (엑셀에 붙여넣으려면 아래 텍스트 전체 선택 후 복사, 또는 복사 버튼 클릭)</div>' +
      '<button id="copyBtn">복사</button>' +
      '<textarea id="tsvArea" readonly></textarea>' +
      '<table><thead><tr>' + headHtml + '</tr></thead><tbody>' + tableRowsHtml + '</tbody></table>' +
      '</body></html>';
    win.document.open();
    win.document.write(html);
    win.document.close();
    var area = win.document.getElementById('tsvArea');
    area.value = tsv;
    area.focus();
    area.select();
    win.document.getElementById('copyBtn').addEventListener('click', function () {
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
        win.navigator.clipboard.writeText(tsv).then(function () {
          win.alert('복사되었습니다.');
        }, function () {
          area.focus();
          area.select();
          win.alert('클립보드 복사에 실패했습니다. 텍스트가 선택되어 있으니 Ctrl+C로 복사하세요.');
        });
      } else {
        area.focus();
        area.select();
        win.alert('이 브라우저는 자동 복사를 지원하지 않습니다. 텍스트가 선택되어 있으니 Ctrl+C로 복사하세요.');
      }
    });
  }

  function createProgressOverlay(title) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.85);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1e293b;padding:30px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.4);width:450px;text-align:center;border:1px solid #334155;';
    box.innerHTML = '<h2 style="margin:0 0 15px 0;font-size:18px;color:#f8fafc;font-weight:bold;">' + escapeHtml(title) + '</h2>' +
      '<div style="background:#334155;border-radius:6px;height:16px;width:100%;overflow:hidden;margin-bottom:12px;">' +
      '<div id="cp-bar" style="background:linear-gradient(90deg,#38bdf8,#0284c7);height:100%;width:0%;transition:width 0.1s ease;"></div></div>' +
      '<div id="cp-txt" style="font-size:14px;color:#94a3b8;font-weight:500;white-space:pre-line;line-height:1.5;">준비 중...</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    var bar = box.querySelector('#cp-bar');
    var txt = box.querySelector('#cp-txt');
    return {
      update: function (current, total, label) {
        var pct = total > 0 ? Math.floor((current / total) * 100) : 0;
        bar.style.width = pct + '%';
        txt.textContent = '진행률: ' + pct + '% (' + current + '/' + total + ')\n현재 처리: ' + label;
      },
      remove: function () {
        overlay.remove();
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

  function runStep1() {
    var container = document.querySelector('#' + CONFIG.LIST_CONTAINER_ID);
    var rows = container.querySelectorAll('table tbody tr');
    if (rows.length === 0) {
      alert('화면에 표시된 행이 없습니다.');
      return;
    }
    var input = prompt('총 ' + rows.length + '개 행. 처리할 행 번호를 입력하세요.\n예: 4  또는  1,3,4  또는  1-3 (1~3도 가능)\n비워두면 전체 처리합니다.');
    if (input === null) return;
    var selected = parseRowSelection(input, rows.length);
    if (selected.length === 0) {
      alert('처리할 행이 없습니다.');
      return;
    }

    var links = [];
    selected.forEach(function (n) {
      var row = rows[n - 1];
      var td2 = row.cells[1];
      var a = td2 ? td2.querySelector('a') : null;
      if (a && a.href) links.push(a.href);
    });
    if (links.length === 0) {
      alert('수집할 링크가 없습니다.');
      return;
    }

    var overlay = createProgressOverlay('1단계: 반품 정보 수집 중');
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
        alert('수집된 데이터가 없습니다. (집품중/집품대기 상태의 아이템이 없을 수 있습니다)');
        return;
      }
      var payload = CONFIG.PAYLOAD_PREFIX + lines.join('\n');
      var winName = 'coupangInv_' + Date.now();
      var win = window.open(CONFIG.INVENTORY_PAGE_URL, winName);
      if (!win) {
        alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
        return;
      }
      win.name = payload;
      alert('데이터 수집 완료 (' + lines.length + '건)! 새 창이 뜨면 그 창에서 이 북마크릿을 한 번 더 눌러주세요.');
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
      alert('데이터를 찾을 수 없습니다. 목록 페이지에서 이 북마크릿을 먼저 실행해 주세요.');
      return;
    }
    window.name = '';
    var body = name.slice(CONFIG.PAYLOAD_PREFIX.length);
    var lines = body.split('\n').filter(function (l) { return l.indexOf('||') !== -1; });
    if (lines.length === 0) {
      alert('처리할 데이터가 없습니다.');
      return;
    }

    var overlay = createProgressOverlay('2단계: 재고 매칭 스캔 중');
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
        alert('수집된 데이터가 없습니다. (수량이 0이거나 일치하는 항목이 없음)');
        return;
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
      renderPopup(rows);
    });
  }

  function main() {
    var task = document.querySelector('#' + CONFIG.LIST_CONTAINER_ID) ? runStep1() : runStep2();
    if (task && task.catch) {
      task.catch(function (err) {
        console.error(err);
        alert('오류 발생: ' + err.message);
      });
    }
  }

  main();
})();
