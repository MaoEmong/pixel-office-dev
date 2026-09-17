# 번들 에셋 출처와 라이선스 (T33 · D-43 4)

이 폴더의 모든 파일은 **재배포 가능한 라이선스**다. 새 에셋을 넣을 때는 반드시 이 표에 한 줄 추가한다.
D-43 4: "CC0 우선, CC-BY 는 LICENSE 기록 조건으로만, **AI 생성 스프라이트는 쓰지 않는다**, 서체 3종 OFL."

| 파일 | 출처 | 버전 | 라이선스 | 라이선스 파일 |
|---|---|---|---|---|
| `sprites/characters.png` | 이 저장소에서 직접 생성(`tool/gen_sprites.dart`) | — | **CC0 1.0** (공개 도메인 기여) | 이 문서 §스프라이트 |
| `fonts/Galmuri11.ttf` | [quiple/galmuri](https://github.com/quiple/galmuri) | v2.40.4 | **SIL OFL 1.1** | `fonts/Galmuri-OFL.txt` |
| `fonts/Pretendard-Regular.otf`, `fonts/Pretendard-Bold.otf` | [orioncactus/pretendard](https://github.com/orioncactus/pretendard) | v1.3.9 | **SIL OFL 1.1** (예약 이름 `Pretendard`) | `fonts/Pretendard-OFL.txt` |
| `fonts/D2Coding.ttf` | [naver/d2-coding-font](https://github.com/naver/d2-coding-font) | VER1.3.3 (20260725, 합자 없는 판) | **SIL OFL 1.1** (예약 이름 `D2Coding`) | `fonts/D2Coding-OFL.txt` |

OFL 1.1 의 의무 셋은 전부 지킨다: ① 폰트 파일 재배포 시 라이선스 전문 동봉(위 3개 txt) ② 예약 글꼴 이름
(`Pretendard`·`D2Coding`)을 **바꾸지 않고 그대로** 쓴다(수정·리네임 없음) ③ 폰트 자체를 판매하지 않는다.

## 스프라이트 — 왜 Kenney 팩이 아니라 직접 그렸나

D-43 4 의 1순위는 "Kenney CC0 16×16 캐릭터를 2× 로 쓰고 포즈는 직접 편집" 이었다. 실제로 받아서 확인했다:

| 후보 | 받은 것 | 왜 안 맞나 |
|---|---|---|
| [Kenney Roguelike Characters 2.0](https://kenney.nl/assets/roguelike-characters) (CC0) | `roguelikeChar_transparent.png` — 16×16, 1px 여백, 450칸 | **정면 서 있는 1포즈짜리 paperdoll**(몸 + 투구·갑옷·무기·방패 레이어)다. 앉음·타이핑·생각·보고·오류 포즈도, **걷기 프레임도 없다** |
| [Kenney Tiny Town](https://kenney.nl/assets/tiny-town) (CC0) | 16×16 타일 130칸 | 캐릭터가 아예 없다(마을 지형·건물·도구 타일). 의자·책상 소품도 없다 |
| Kenney Micro Roguelike / 1-Bit Pack | 8×8 · 16×16 1비트 | 같은 이유(1포즈) + 해상도·색 수가 사무실 화면과 안 맞는다 |

D-43 2 가 요구하는 것은 **포즈 8종 + 걷기 4프레임**이다. 위 팩 중 어느 것도 프레임을 주지 않으므로
"직접 편집" 은 사실상 전부 새로 그리는 일이 된다. 그래서 **손으로 쓴 픽셀 좌표를 코드로 찍는 방식**을 골랐다:

- 생성기: `dev/app/tool/gen_sprites.dart` (순수 Dart, 의존성 0 — PNG 인코더까지 직접). `dart run tool/gen_sprites.dart` 로 재생성.
- **AI 이미지 생성이 아니다.** 결정론적 도형 코드이므로 D-43 4 의 "AI 생성 스프라이트 금지"(프레임 간
  일관성·라이선스 불명)에 걸리지 않는다. 오히려 프레임 일관성은 코드가 보장한다 — 몸·머리·팔·다리를 같은
  함수로 그리고, 외곽선은 실루엣에서 자동 생성하며, 걷기 오른쪽은 왼쪽을 **좌우 반전**한 것이다.
- 저작권: 이 저장소의 산출물이고 외부 에셋을 한 픽셀도 포함하지 않는다. **CC0 1.0** 으로 둔다.

Kenney 팩 파일은 **저장소에 넣지 않았다**(쓰지 않았으므로). 위 판단을 다시 확인하려면 각 링크에서 받아 보면 된다.
