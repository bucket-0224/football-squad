# 풋볼 스쿼드 — Android (Capacitor WebView 래퍼)

배포된 웹앱(`capacitor.config.json`의 `server.url`)을 그대로 여는 WebView 래퍼입니다.
아직 도메인/HTTPS가 없어서 TWA(Trusted Web Activity) 대신 이 방식으로 우선 빌드했습니다 —
TWA는 HTTPS가 필수라 평문 HTTP 주소로는 주소창 없는 완전한 "네이티브 앱" 느낌을 낼 수 없습니다.
HTTPS 도메인이 준비되면 TWA(Bubblewrap)로 교체하는 것을 권장합니다.

## 재빌드 방법

```bash
# 최초 1회
export JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot"
export ANDROID_HOME="C:\Android\sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

npm install

# capacitor.config.json의 server.url을 바꾼 뒤
npx cap sync android

cd android
./gradlew.bat assembleDebug
# 결과물: android/app/build/outputs/apk/debug/app-debug.apk
```

## 설치 방법 (사이드로드)

1. `app-debug.apk`를 폰으로 전송 (USB/클라우드/메신저 등)
2. 폰에서 파일을 열고 "출처를 알 수 없는 앱" 설치 허용
3. 설치 후 실행 — `capacitor.config.json`에 지정된 주소를 그대로 엽니다

## 아이콘/스플래시 재생성

`assets/icon.png`(정사각 512px), `assets/icon-foreground.png`(안전영역 내 로고),
`assets/icon-background.png`(단색 배경)를 교체한 뒤:

```bash
npx capacitor-assets generate --android
```

## 서명(릴리즈) 빌드가 필요해지면

지금은 Gradle이 자동 생성하는 디버그 키스토어로 서명됩니다 (테스트/사이드로드용으로 충분).
Play 스토어 배포나 장기적으로 같은 서명 아이덴티티를 유지해야 한다면 별도 keystore를 만들어
`android/app/build.gradle`의 `signingConfigs`에 연결해야 합니다 — 이 keystore는 이후 모든
업데이트에 계속 쓰이므로 분실하지 않게 백업이 중요합니다.
