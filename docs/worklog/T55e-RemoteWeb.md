# T55e — 원격 web 화면

PC가 제공하는 HTML/CSS/JS만 사용한다. 로그인·외부 분석·외부 font·CDN은 없다.
390px 모바일 폭, 사무실 상태, 부서 선택, 대화·회의·승인·질문·보고·검수 화면을 구현했다.
브라우저 개인키는 WebCrypto non-extractable + IndexedDB, 작업 데이터는 메모리에만 둔다.
QR fragment를 읽은 뒤 주소에서 지운다. 자동 challenge 인증·새로고침·끊김 후 재연결,
서명 해제·offline tombstone 동기화를 구현했다.

검증: 실제 headless Chrome 390x844에서 등록→승인→reload→대화→시작→Write 승인→보고→검수,
offline 해제→online reload→PC revoked, 개인키 export 실패, 작업 데이터 저장 없음, 가로 넘침 없음 통과(6초).
페이지 준비 전에 등록 버튼을 누를 수 있던 경합을 수정해 준비 완료까지 비활성화했다.
다음: T55f 실제 CLI + 회귀, T55g PC/브라우저 직접 조작.
