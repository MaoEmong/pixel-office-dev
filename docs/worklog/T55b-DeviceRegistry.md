# T55b — 기기 인증 영속 저장

PC 로컬 SQLite remote-devices.db, PC identity, 공개키·지문·승인·해제 기록을 구현했다.
ECDSA P-256 공개키와 IEEE-P1363 서명만 허용하며 공개키 인코딩을 정규화한다.
5분/1회용 초대 키는 메모리에 해시만 보관한다. 원격 명령 중복 방지 기록도 PC에 남긴다.
검증: typecheck, DeviceRegistry.test.ts 통과(만료·서명·중복·승인·재열기·해제·요청 기록).
Windows 테스트 정리 순서에서 DB 닫기 전에 폴더를 지우던 fixture를 수정했다.
다음: T55c 인증 challenge·게이트웨이.
