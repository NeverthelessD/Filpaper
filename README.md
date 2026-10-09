# Flipaper

이미지 ⇄ PDF 변환 · PDF 용량 줄이기 (macOS) — made by. Nevertheless_D

| 메뉴 | 하는 일 |
|---|---|
| **이미지 → PDF** | JPG · PNG · HEIC · WEBP · TIFF 여러 장을 원하는 순서로 하나의 PDF(또는 장마다 PDF)로. 용지 A4 기본 · 직접 지정, 비율 유지, 해상도 4단계 |
| **PDF → 이미지** | PDF 각 쪽을 JPG/PNG로, 해상도 4단계 |
| **PDF 용량 줄이기** | 스마트 압축(글자 그대로, 사진만 줄임) · 강력 압축, 미리보기로 먼저 확인 |

- 파일 개수 제한 없음, 미리보기, 저장 폴더 · 기본 폴더 지정, 라이트/다크 모드(기본: macOS 설정)
- **자동 업데이트**: 이 저장소의 `releases/latest.json`을 확인해 새 버전을 받아요. 오른쪽 위 버전 배지에서 수동 확인 · 이전 버전 되돌리기도 돼요.

## 설치

1. [`releases/`](releases) 폴더에서 가장 최신 `Flipaper-x.y.z.zip`을 받아 압축을 풀어요.
2. `Flipaper.app`을 **응용 프로그램** 폴더로 옮겨요. (업데이트가 동작하려면 꼭 옮겨 주세요)
3. 처음 열 때 경고가 뜨면 **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"**.

설정 · 임시 파일은 `~/Library/Application Support/Flipaper` 한 폴더에만 저장돼요.

## 폴더 구조

```
engine/     Go 엔진 (로컬 서버 · 이미지/PDF 처리 · 업데이트)
engine/web/ 앱 화면 (HTML · CSS · JS, pdf-lib · pdf.js 포함)
app/        Flipaper.app 껍데기 (실행 스크립트 · Info.plist · 아이콘)
scripts/    빌드 스크립트
releases/   업데이트 파일 (Flipaper-x.y.z.zip, latest.json)
docs/       사용 가이드 이미지
```

사용한 오픈소스: [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [golang.org/x/image](https://pkg.go.dev/golang.org/x/image) (BSD)
