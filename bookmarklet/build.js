// 빌드 스크립트: src/bookmarklet.js -> javascript: URI로 변환
// 의존성 없이 순수 Node로 동작. 실행: node bookmarklet/build.js
'use strict';

var fs = require('fs');
var path = require('path');

var SRC_PATH = path.join(__dirname, 'src', 'bookmarklet.js');
var DIST_DIR = path.join(__dirname, 'dist');
var DIST_PATH = path.join(DIST_DIR, 'bookmarklet.url.txt');

function stripComments(source) {
  var lines = source.split('\n');
  var out = [];
  var inBlockComment = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (inBlockComment) {
      var endIdx = trimmed.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        var rest = trimmed.slice(endIdx + 2).trim();
        if (rest !== '') out.push(rest);
      }
      continue;
    }
    if (trimmed.indexOf('/*') === 0) {
      var closeIdx = trimmed.indexOf('*/', 2);
      if (closeIdx !== -1) {
        var afterBlock = trimmed.slice(closeIdx + 2).trim();
        if (afterBlock !== '') out.push(afterBlock);
      } else {
        inBlockComment = true;
      }
      continue;
    }
    if (trimmed.indexOf('//') === 0) continue;
    if (trimmed === '') continue;
    out.push(trimmed);
  }
  return out.join('\n');
}

function build() {
  var source = fs.readFileSync(SRC_PATH, 'utf8');
  var stripped = stripComments(source);
  var uri = 'javascript:' + encodeURIComponent(stripped);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_PATH, uri, 'utf8');

  console.log('Bookmarklet URI written to: ' + DIST_PATH);
  console.log('Length: ' + uri.length + ' characters');
  if (uri.length > 60000) {
    console.warn('경고: URI가 매우 깁니다 (' + uri.length + '자). 일부 브라우저에서 북마크 URL 길이 제한에 걸릴 수 있습니다.');
  }
  console.log('');
  console.log(uri);
}

build();
