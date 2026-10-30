package com.apkplatform.testclient;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.content.SharedPreferences;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

public final class MainActivity extends Activity {
  private TextView state, details;
  private SharedPreferences prefs;
  private volatile boolean closed;
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(32,48,32,32);
    TextView title=new TextView(this); title.setText("中台自有测试 APK"); title.setTextSize(24); root.addView(title);
    state=new TextView(this); state.setText("正在读取本轮测试配置"); state.setTextSize(18); root.addView(state);
    details=new TextView(this); root.addView(details); setContentView(root);
    report("PREPARING");
    prefs=getSharedPreferences("owned_test",MODE_PRIVATE);
    if(prefs.contains("accountId")) { report("HTTP_200"); state.setText("测试账户已上报"); details.setText("用户名："+prefs.getString("username","")+"\n同一安装复用原账户"); return; }
    try {
      File config=new File(getFilesDir(),"bootstrap.json");
      if(!config.isFile()) { report("CONFIG_ERROR"); state.setText("请通过中台任务启动此测试 APK"); return; }
      JSONObject boot=new JSONObject(read(new FileInputStream(config),16384));
      URL url=new URL(boot.getString("apiUrl"));
      if(!"https".equals(url.getProtocol()) && !("http".equals(url.getProtocol()) && "127.0.0.1".equals(url.getHost())))
        throw new IOException("ENDPOINT_INVALID");
      String token=boot.getString("token"), ua=boot.getString("userAgent");
      if(!token.matches("[-_A-Za-z0-9]{43}") || !ua.matches("[ -~]{1,512}")) throw new IOException("CONFIG_INVALID");
      String payload=prefs.getString("pendingBody",null);
      if(payload==null) {
        String deviceId=Settings.Secure.getString(getContentResolver(),Settings.Secure.ANDROID_ID);
        JSONObject body=new JSONObject();
        body.put("installationId",UUID.randomUUID().toString()); body.put("requestKey",UUID.randomUUID().toString());
        body.put("androidId",deviceId); body.put("model",Build.MODEL); body.put("manufacturer",Build.MANUFACTURER);
        body.put("apiLevel",Build.VERSION.SDK_INT); body.put("locale",Locale.getDefault().toLanguageTag());
        body.put("declaredUserAgent",ua); body.put("appliedWebViewUa","NOT_COLLECTED");
        body.put("defaultWebViewUa","NOT_COLLECTED"); body.put("appVersion","1.0.1");
        payload=body.toString();
        if(!prefs.edit().putString("pendingBody",payload).commit()) throw new IOException("JOURNAL_FAILED");
      }
      final String stableBody=payload;
      details.setText("型号："+Build.MODEL+"\n系统 API："+Build.VERSION.SDK_INT+"\n正在通过本轮网络上报");
      new Thread(() -> enroll(url,token,ua,stableBody),"owned-test-enroll").start();
    } catch(Exception e) { report("CONFIG_ERROR"); state.setText("测试配置不可用；未创建新账户"); }
  }
  private void show(String text) { if(!closed)runOnUiThread(()->{if(!closed)state.setText(text);}); }
  private void enroll(URL url,String token,String ua,String body) {
    for(int attempt=0;attempt<3&&!closed;attempt++) {
      HttpURLConnection connection=null;
      try {
        connection=(HttpURLConnection)url.openConnection(); connection.setRequestMethod("POST");
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(7000); connection.setReadTimeout(7000);
        connection.setRequestProperty("Authorization","Bearer "+token); connection.setRequestProperty("Content-Type","application/json");
        connection.setRequestProperty("User-Agent",ua); connection.setDoOutput(true);
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
        try(OutputStream out=connection.getOutputStream()) { out.write(bytes); }
        int status=connection.getResponseCode();
        report("HTTP_"+status);
        if(status==200) {
          JSONObject response=new JSONObject(read(connection.getInputStream(),16384));
          prefs.edit().putString("accountId",response.getString("id")).putString("username",response.getString("username")).commit();
          show("账户创建并上报成功\n用户名："+response.getString("username")+"\n创建请求 IP："+response.getString("sourceIp")+"\n密码已加密保存到中台");
          return;
        }
        if(status>=400&&status<500) { show("本轮上报未获接受（"+status+"），未更换请求编号"); return; }
      } catch(Exception e) { report(e instanceof javax.net.ssl.SSLException ? "NETWORK_TLS" : e instanceof java.net.SocketTimeoutException ? "NETWORK_TIMEOUT" : e instanceof java.net.ConnectException ? "NETWORK_CONNECT" : "NETWORK_ERROR"); /* Retry the same persisted body; no exception text enters logs. */ }
      finally { if(connection!=null)connection.disconnect(); }
      try { Thread.sleep(500L*(attempt+1)); } catch(InterruptedException e) { Thread.currentThread().interrupt(); return; }
    }
    show("上报结果尚未确认；中台记录为准，不重复生成账户");
  }
  private void report(String code) {
    if(!code.matches("(?:PREPARING|CONFIG_ERROR|NETWORK_(?:ERROR|TLS|TIMEOUT|CONNECT)|HTTP_[1-5][0-9]{2})"))return;
    try(FileOutputStream out=new FileOutputStream(new File(getFilesDir(),"report-status"))) { out.write(code.getBytes(StandardCharsets.US_ASCII)); } catch(IOException ignored) {}
    android.util.Log.i("ApkPlatformTest",code);
  }
  private static String read(InputStream in,int max) throws IOException {
    try(InputStream source=in;ByteArrayOutputStream out=new ByteArrayOutputStream()) {
      byte[] buffer=new byte[2048]; int n; while((n=source.read(buffer))!=-1) { if(out.size()+n>max)throw new IOException("TOO_LARGE");out.write(buffer,0,n); }
      return new String(out.toByteArray(),StandardCharsets.UTF_8);
    }
  }
  @Override public void onDestroy() { closed=true; super.onDestroy(); }
}
