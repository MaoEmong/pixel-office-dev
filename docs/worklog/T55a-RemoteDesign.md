# T55a — 기기 연결 설계

사용자 요구: 로그인 없는 QR/키 등록, 해제 전까지 인증 유지, 작업 데이터 PC 저장,
모바일·다른 PC에서 조작. Cloudflare와 구매 도메인 연결은 후속으로 보류.
계약과 7단계 태스크를 작성했다. 키쌍 기반 challenge와 PC 승인을 선택하고
공유 비밀번호/데몬 master token 배포는 채택하지 않았다.
오프라인 해제를 상대 PC에 즉시 통지할 수 없다는 한계를 명시하고 tombstone으로 동기화한다.
검증: 기존 RpcServer 인증/알림, daemon 수명주기, Flutter menu 구조와 WebCrypto/Node 서명 형식 확인.
다음: T55b 영속 기기 저장소.
