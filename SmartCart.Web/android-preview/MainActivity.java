package com.smartcart.preview;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String SMARTCART_HOST = "10.0.2.2";
    private static final int DEFAULT_PORT = 4173;
    private static final String PORT_EXTRA = "smartcartPort";
    private static final int FILE_REQUEST = 1;
    private int smartCartPort;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int requestedPort = getIntent().getIntExtra(PORT_EXTRA, DEFAULT_PORT);
        smartCartPort = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : DEFAULT_PORT;

        int background = Color.rgb(11, 9, 18);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        webView = new WebView(this);
        webView.setBackgroundColor(background);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) && SMARTCART_HOST.equals(uri.getHost()) && uri.getPort() == smartCartPort) {
                    return false;
                }
                if (request.isForMainFrame() && ("http".equals(scheme) || "https".equals(scheme))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException e) {
                        Toast.makeText(MainActivity.this, "No browser available", Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                return true;
            }
        });

        setContentView(webView);
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl("http://" + SMARTCART_HOST + ":" + smartCartPort + "/");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        webView.saveState(state);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
