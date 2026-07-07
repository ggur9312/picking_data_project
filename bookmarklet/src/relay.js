// 쿠팡 재고조회(inventory.coupang.com) 탭에서 실행하는 릴레이 북마크릿
//
// 목록 페이지(inbound.coupang.com)는 다른 도메인이라 inventory.coupang.com의
// 재고 API를 직접 fetch()하면 CORS로 막힙니다. 이 릴레이는 inventory.coupang.com
// 탭 안에서 같은 출처(same-origin)로 fetch를 대신 수행하고, 결과를
// postMessage로 메인 북마크릿에 돌려줍니다.
//
// 주의: 이 파일은 build.js가 "한 줄 시작 // 주석"과 "/* */ 블록"만 제거해서 압축합니다.
// 코드가 있는 줄 끝에 // 주석을 붙이지 마세요 (특히 URL 문자열이 있는 줄).
(function () {
  'use strict';

  var SOURCE_RELAY = 'coupang-vr-relay';
  var SOURCE_MAIN = 'coupang-vr-bookmarklet';

  if (window.__coupangVrRelayActive) {
    alert('릴레이가 이미 실행 중입니다.');
    return;
  }
  window.__coupangVrRelayActive = true;

  function buildInventoryUrl(skuId) {
    return 'https://inventory.coupang.com/async/inventory/search?searched=true&locationType=PICKING&skuId=' +
      encodeURIComponent(skuId) + '&availableInventory=true&page=0&pageSize=20';
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== SOURCE_MAIN) return;

    if (data.type === 'PING') {
      event.source.postMessage({ source: SOURCE_RELAY, type: 'PONG' }, event.origin);
      return;
    }

    if (data.type === 'INVENTORY_QUERY') {
      var requestId = data.requestId;
      var skuId = data.skuId;
      fetch(buildInventoryUrl(skuId), { credentials: 'same-origin' })
        .then(function (resp) {
          if (!resp.ok) throw new Error('요청 실패 (' + resp.status + ')');
          return resp.json();
        })
        .then(function (json) {
          event.source.postMessage({
            source: SOURCE_RELAY, type: 'INVENTORY_RESULT', requestId: requestId, ok: true, json: json
          }, event.origin);
        })
        .catch(function (err) {
          event.source.postMessage({
            source: SOURCE_RELAY, type: 'INVENTORY_RESULT', requestId: requestId, ok: false, error: String(err && err.message || err)
          }, event.origin);
        });
    }
  });

  console.log('쿠팡 재고조회 릴레이가 준비되었습니다. 이 탭을 닫지 말고 메인 북마크릿을 실행하세요.');
  alert('릴레이 준비 완료. 이 탭을 열어둔 채로 목록 페이지에서 메인 북마크릿을 실행하세요.');
})();
