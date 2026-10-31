package com.apkplatform.testclient;

import android.app.Activity;
import android.app.AlertDialog;
import android.widget.Button;
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
  private EnrollmentSender sender;
  private volatile boolean closed;
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(32,48,32,32);
    TextView title=new TextView(this); title.setText("中台自有测试 APK"); title.setTextSize(24); root.addView(title);
    state=new TextView(this); state.setText("正在读取本轮测试配置"); state.setTextSize(18); root.addView(state);
    details=new TextView(this); root.addView(details); setContentView(root);
    report("PREPARING");
    initializeClient();
    if (getPackageName().contains(".app")) {
      state.setText("测试开屏广告（不含业务内容）");
      Button skip=new Button(this); skip.setText("跳过广告"); root.addView(skip);
      skip.setOnClickListener(v -> { root.removeView(skip); new AlertDialog.Builder(this).setTitle("测试公告").setMessage("此公告用于验证关闭流程").setCancelable(false).setPositiveButton("关闭",(dialog,which)->state.setText(prefs!=null&&prefs.contains("accountId")?"测试账户已上报":sender==null?"请通过中台任务启动此测试 APK":"正在通过本轮网络上报")).show(); });
    }
  }
  private void initializeClient() {
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
        body.put("defaultWebViewUa","NOT_COLLECTED"); body.put("appVersion","1.1.2"); body.put("packageName",getPackageName());
        payload=body.toString();
        if(!prefs.edit().putString("pendingBody",payload).commit()) throw new IOException("JOURNAL_FAILED");
      }
      final String stableBody=payload;
      details.setText("型号："+Build.MODEL+"\n系统 API："+Build.VERSION.SDK_INT+"\n正在通过本轮网络上报");
      sender=new EnrollmentSender();
      new Thread(() -> enroll(url,token,ua,stableBody),"owned-test-enroll").start();
    } catch(Exception e) { report("CONFIG_ERROR"); state.setText("测试配置不可用；未创建新账户"); }
  }
  private void show(String text) { if(!closed)runOnUiThread(()->{if(!closed)state.setText(text);}); }
  private void enroll(URL url,String token,String ua,String body) {
    sender.send(url,token,ua,body,new EnrollmentSender.Listener() {
      @Override public void status(String code) {
        if(closed)return;
        report(code);
        if(!"HTTP_200".equals(code))show("上报结果尚未确认；中台记录为准，不重复生成账户");
      }
      @Override public void accepted(String value) throws Exception {
        if(closed)throw new IOException("CANCELLED");
        JSONObject response=new JSONObject(value);
        String id=response.getString("id"), username=response.getString("username");
        String password=response.getString("password"), ip=response.getString("sourceIp");
        if(!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new IOException("INVALID_RESPONSE");
        UUID.fromString(id);
        java.time.Instant.parse(response.getString("createdAt"));
        if(!username.matches("[a-z]{6,10}") || !password.matches("(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,12}") || !ip.matches("[0-9A-Fa-f:.]{2,64}"))throw new IOException("INVALID_RESPONSE");
        if(!prefs.edit().putString("accountId",id).putString("username",username).commit())throw new IOException("JOURNAL_FAILED");
        show("账户创建并上报成功\n用户名："+username+"\n创建请求 IP："+ip+"\n密码已加密保存到中台");
      }
    });
  }
  private void report(String code) {
    if(!code.matches("(?:PREPARING|CONFIG_ERROR|NETWORK_(?:ERROR|TLS|TIMEOUT|CONNECT)|HTTP_[1-5][0-9]{2})"))return;
    android.util.AtomicFile file=new android.util.AtomicFile(new File(getFilesDir(),"report-status"));
    FileOutputStream out=null;
    try { out=file.startWrite(); out.write(code.getBytes(StandardCharsets.US_ASCII)); file.finishWrite(out); }
    catch(IOException ignored) { if(out!=null)file.failWrite(out); }
    android.util.Log.i("ApkPlatformTest",code);
  }
  private static String read(InputStream in,int max) throws IOException {
    try(InputStream source=in;ByteArrayOutputStream out=new ByteArrayOutputStream()) {
      byte[] buffer=new byte[2048]; int n; while((n=source.read(buffer))!=-1) { if(out.size()+n>max)throw new IOException("TOO_LARGE");out.write(buffer,0,n); }
      return new String(out.toByteArray(),StandardCharsets.UTF_8);
    }
  }
  @Override public void onDestroy() { closed=true; if(sender!=null)sender.cancel(); super.onDestroy(); }
}
