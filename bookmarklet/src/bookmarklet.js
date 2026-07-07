// 쿠팡 벤더 반품(vendor-return) 처리 데이터 수집 북마크릿
//
// 주의: 이 파일은 build.js가 "한 줄 시작 // 주석"과 "/* */ 블록"만 제거해서 압축합니다.
// 코드가 있는 줄 끝에 // 주석을 붙이지 마세요 (특히 URL 문자열이 있는 줄).
// 주석은 항상 자기 줄에 단독으로 작성합니다.
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG: 실제 사이트를 보지 않고 명세만으로 추정한 값들을 모두 여기에 모아둠.
  // 실제 동작이 다르면 이 블록만 고치면 됨.
  // ---------------------------------------------------------------------
  var CONFIG = {
    LIST_TABLE_ID: 'vendorReturnOrderPage',
    DETAIL_TABLE1_COLS: {
      groupNo: 0,
      purchaseType: 3,
      createdAt: 5,
      deadline: 6,
      status: 7,
      vendorReturnOrderId: 2
    },
    DETAIL_TABLE2_COLS: {
      vendorName: 0,
      transportType: 3
    },
    ITEM_LIST_SKU_COL: 0,
    ITEM_LIST_URL: function (vendorReturnOrderId) {
      return 'https://inbound.coupang.com/vendor-return/order/item/paging?page=0&isVirtualVendorReturn=false&vendorReturnOrderId=' +
        encodeURIComponent(vendorReturnOrderId) + '&orderItemSearchStatus=&size=1000';
    },
    INVENTORY_URL: function (skuId) {
      return 'https://inventory.coupang.com/async/inventory/search?searched=true&locationType=PICKING&skuId=' +
        encodeURIComponent(skuId) + '&availableInventory=true&page=0&pageSize=20';
    },
    INVENTORY_ARRAY_PATHS: ['', 'content', 'data', 'list', 'rows'],
    MIN_ALLOCATED_QTY: 1,
    ZONE_REGEX: /^\d+[A-Za-z]+/,
    LOCATION_BARCODE_SPLIT_INDEX: 1,
    FETCH_CREDENTIALS: 'include',
    DELAY_MS: 150
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

  function getAllDataRows(table) {
    var tbody = table.querySelector('tbody');
    if (tbody) return Array.prototype.slice.call(tbody.rows);
    return Array.prototype.slice.call(table.rows);
  }

  function getFirstDataRow(table) {
    var rows = getAllDataRows(table);
    return rows.length > 0 ? rows[0] : null;
  }

  function getCellText(table, colIndex) {
    var row = getFirstDataRow(table);
    if (!row || !row.cells[colIndex]) return null;
    return row.cells[colIndex].textContent.trim();
  }

  function fetchAndParseHtml(url) {
    return fetch(url, { credentials: CONFIG.FETCH_CREDENTIALS }).then(function (resp) {
      if (!resp.ok) throw new Error('요청 실패 (' + resp.status + '): ' + url);
      return resp.text();
    }).then(function (text) {
      return new DOMParser().parseFromString(text, 'text/html');
    });
  }

  function fetchJson(url) {
    return fetch(url, { credentials: CONFIG.FETCH_CREDENTIALS }).then(function (resp) {
      if (!resp.ok) throw new Error('요청 실패 (' + resp.status + '): ' + url);
      return resp.json();
    });
  }

  function extractInventoryArray(json) {
    for (var i = 0; i < CONFIG.INVENTORY_ARRAY_PATHS.length; i++) {
      var path = CONFIG.INVENTORY_ARRAY_PATHS[i];
      var candidate = path === '' ? json : (json ? json[path] : undefined);
      if (Array.isArray(candidate)) return candidate;
    }
    console.error('알 수 없는 재고 API 응답 구조, 원본 JSON:', JSON.stringify(json));
    return [];
  }

  function zoneFromLocationBarcode(barcode) {
    if (!barcode) return null;
    var segments = barcode.split('-');
    if (segments.length <= CONFIG.LOCATION_BARCODE_SPLIT_INDEX) {
      console.warn('예상치 못한 locationBarcode 형식:', barcode);
      return null;
    }
    var segment = segments[CONFIG.LOCATION_BARCODE_SPLIT_INDEX];
    var match = segment.match(CONFIG.ZONE_REGEX);
    return match ? match[0] : null;
  }

  function scrapeCommonData(doc) {
    var tables = doc.querySelectorAll('table');
    if (tables.length < 2) {
      throw new Error('상세 페이지에서 테이블 2개를 찾지 못함 (찾은 개수: ' + tables.length + ')');
    }
    var table1 = tables[0];
    var table2 = tables[1];
    var common = {
      groupNo: getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.groupNo),
      deadline: getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.deadline),
      createdAt: getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.createdAt),
      purchaseType: getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.purchaseType),
      status: getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.status),
      vendorName: getCellText(table2, CONFIG.DETAIL_TABLE2_COLS.vendorName),
      transportType: getCellText(table2, CONFIG.DETAIL_TABLE2_COLS.transportType)
    };
    var vendorReturnOrderId = getCellText(table1, CONFIG.DETAIL_TABLE1_COLS.vendorReturnOrderId);
    return { common: common, vendorReturnOrderId: vendorReturnOrderId };
  }

  function scrapeSkuIds(doc) {
    var table = doc.querySelector('table');
    if (!table) return [];
    return getAllDataRows(table)
      .map(function (row) {
        var cell = row.cells[CONFIG.ITEM_LIST_SKU_COL];
        return cell ? cell.textContent.trim() : null;
      })
      .filter(Boolean);
  }

  function scrapeInventoryRows(skuId) {
    return fetchJson(CONFIG.INVENTORY_URL(skuId)).then(function (json) {
      var entries = extractInventoryArray(json);
      var results = [];
      entries.forEach(function (entry) {
        var qty = Number(entry.allocatedQuantity);
        if (!(qty >= CONFIG.MIN_ALLOCATED_QTY)) return;
        var zone = zoneFromLocationBarcode(entry.locationBarcode);
        if (zone == null) return;
        results.push({ zone: zone, qty: qty });
      });
      return results;
    });
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

  function main() {
    var table = document.getElementById(CONFIG.LIST_TABLE_ID);
    if (!table) {
      alert('테이블을 찾을 수 없습니다: #' + CONFIG.LIST_TABLE_ID);
      return Promise.resolve();
    }
    var dataRows = getAllDataRows(table);
    var totalRows = dataRows.length;
    if (totalRows === 0) {
      alert('데이터 행이 없습니다.');
      return Promise.resolve();
    }

    var input = prompt('총 ' + totalRows + '개 행. 처리할 행 번호를 입력하세요.\n예: 4  또는  1,3,4  또는  1-3 (1~3도 가능)\n비워두면 전체 처리합니다.');
    if (input === null) return Promise.resolve();

    var selectedRowNumbers = parseRowSelection(input, totalRows);
    if (selectedRowNumbers.length === 0) {
      alert('처리할 행이 없습니다.');
      return Promise.resolve();
    }

    var outputRows = [];

    function processRow(rowNum) {
      var row = dataRows[rowNum - 1];
      var anchor = row.cells[1] ? row.cells[1].querySelector('a') : null;
      if (!anchor) {
        console.warn(rowNum + '번 행: 2번째 셀에서 링크를 찾지 못해 건너뜀');
        return Promise.resolve();
      }
      var detailUrl = anchor.href;
      var common, vendorReturnOrderId;

      return fetchAndParseHtml(detailUrl)
        .then(function (detailDoc) {
          return sleep(CONFIG.DELAY_MS).then(function () { return detailDoc; });
        })
        .then(function (detailDoc) {
          var scraped = scrapeCommonData(detailDoc);
          common = scraped.common;
          vendorReturnOrderId = scraped.vendorReturnOrderId;
          if (!vendorReturnOrderId) throw new Error(rowNum + '번 행: vendorReturnOrderId를 찾지 못함');
          return fetchAndParseHtml(CONFIG.ITEM_LIST_URL(vendorReturnOrderId));
        })
        .then(function (itemListDoc) {
          return sleep(CONFIG.DELAY_MS).then(function () { return itemListDoc; });
        })
        .then(function (itemListDoc) {
          var skuIds = scrapeSkuIds(itemListDoc);
          var chain = Promise.resolve();
          skuIds.forEach(function (skuId) {
            chain = chain.then(function () {
              return scrapeInventoryRows(skuId).then(function (invRows) {
                return sleep(CONFIG.DELAY_MS).then(function () {
                  invRows.forEach(function (ir) {
                    outputRows.push([
                      common.groupNo, common.deadline, common.createdAt, common.purchaseType,
                      common.vendorName, common.status, common.transportType, ir.zone, ir.qty
                    ]);
                  });
                });
              });
            });
          });
          return chain;
        })
        .catch(function (err) {
          console.error(rowNum + '번 행 처리 중 오류:', err);
        });
    }

    var pipeline = Promise.resolve();
    selectedRowNumbers.forEach(function (rowNum) {
      pipeline = pipeline.then(function () { return processRow(rowNum); });
    });

    return pipeline.then(function () {
      renderPopup(outputRows);
    });
  }

  main().catch(function (err) {
    console.error(err);
    alert('오류 발생: ' + err.message);
  });
})();
