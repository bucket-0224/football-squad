package com.footballsquad.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // 당겨서 새로고침처럼 보이는 오버스크롤 글로우 효과를 끈다 — 이게
            // 남아있으면 "웹뷰 안에 웹사이트"처럼 보이는 가장 큰 원인 중 하나.
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            // 길게 눌렀을 때 뜨는 텍스트 선택/복사 팝업 억제 — 카드 드래그 등
            // 앱 내 제스처와 겹치고, 웹페이지 느낌을 강하게 준다.
            webView.setLongClickable(false);
            webView.setHapticFeedbackEnabled(false);
        }
    }
}
