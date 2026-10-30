package FIXTURE_PACKAGE;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.view.View;
import android.view.MotionEvent;
import android.app.Dialog;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

// Owned acceptance APK only. No production app or third-party service is contacted.
public final class MainActivity extends Activity {
    private String username = "";
    private LinearLayout layout;
    private EditText user, password, confirmation;
    private void label(String text) { TextView view = new TextView(this); view.setText(text); layout.addView(view); }
    private void page(String title) {
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        if (FIXTURE_EPSILON || FIXTURE_ZETA || FIXTURE_ETA) {
            Bitmap image = Bitmap.createBitmap(320, 320, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(image); canvas.drawColor(Color.rgb(230, 240, 250));
            Paint ink = new Paint(); ink.setColor(Color.rgb(90, 130, 160)); ink.setTextSize(18);
            canvas.drawCircle(260, 260, 40, ink); canvas.drawText("Owned visual content", 8, 300, ink);
            layout.setBackground(new BitmapDrawable(getResources(), image));
        }
        // API 35 enforces edge-to-edge; keep the fixture title below the status bar.
        layout.setPadding(32, Math.round(64 * getResources().getDisplayMetrics().density), 32, 32); TextView heading = new TextView(this);
        heading.setText(title); layout.addView(heading); setContentView(layout);
    }
    private Button button(String label, int id) {
        Button b = new Button(this); b.setId(id); b.setText(label); layout.addView(b); return b;
    }
    private EditText input(String hint, int id, boolean hidden) {
        EditText e = new EditText(this); e.setId(id); e.setHint(hint);
        e.setInputType(hidden ? 129 : 145); e.setSingleLine(true); layout.addView(e); return e;
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); page("Owned P3 fixture");
        if (FIXTURE_THETA) {
            page("网络连接失败"); button("重试", R.id.retry_load).setOnClickListener(v -> {
                page("正在加载…"); new Handler(Looper.getMainLooper()).postDelayed(() -> startupSplash(), 2500);
            }); return;
        }
        if (FIXTURE_ZETA) { page("个人中心"); label("游客"); label("用户ID：12345678"); return; }
        if (FIXTURE_ETA) { page("热门推荐"); label("站长精选"); for (int i=0;i<8;i++) button("Owned App "+i, View.generateViewId()); return; }
        if (FIXTURE_EPSILON) {
            page("Home"); button("点击登录", R.id.login).setOnClickListener(v -> {
                page("登录"); input("Username", R.id.login_username, false); input("Password", R.id.login_password, true);
                button("登录", R.id.login_submit); button("注册新账号", R.id.open_register).setOnClickListener(w -> form());
            }); return;
        }
        if (FIXTURE_GAMMA) {
            page("Home"); button("My", R.id.my).setOnClickListener(v -> {
                page("Account"); button("Login", R.id.login).setOnClickListener(w -> {
                    page("Login"); input("Username", R.id.login_username, false); input("Password", R.id.login_password, true);
                    button("Login", R.id.login_submit); button("Register", R.id.open_register).setOnClickListener(x -> form());
                });
            }); return;
        }
        if (FIXTURE_DELTA) {
            setContentView(new View(this) {
                final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                @Override protected void onDraw(Canvas canvas) {
                    canvas.drawColor(Color.WHITE); paint.setColor(Color.BLACK); paint.setTextSize(48 * getResources().getDisplayMetrics().scaledDensity);
                    canvas.drawText("Register", 60, 360, paint);
                }
                @Override public boolean onTouchEvent(MotionEvent event) {
                    if (event.getAction() == MotionEvent.ACTION_UP && event.getX() >= 40 && event.getX() <= getWidth() - 40 && event.getY() >= 160 && event.getY() <= 420) { form(); return true; }
                    return true;
                }
            }); return;
        }
        button("Open registration", R.id.open_register).setOnClickListener(v -> form());
    }
    private void startupSplash() {
        page("开屏广告");
        Button skip = button("跳过 1 秒", R.id.skip_ad); skip.setEnabled(false);
        new Handler(Looper.getMainLooper()).postDelayed(() -> { skip.setText("跳过广告"); skip.setEnabled(true); }, 1000);
        skip.setOnClickListener(v -> {
            skip.setEnabled(false);
            new Handler(Looper.getMainLooper()).postDelayed(() -> startupNotice(), 1800);
        });
    }
    private void startupNotice() {
        page("系统公告");
        Button ack = button("我知道了", R.id.notice_ack);
        ack.setOnClickListener(v -> { ack.setEnabled(false); new Handler(Looper.getMainLooper()).postDelayed(() -> startupTransition(), 1800); });
    }
    private void startupTransition() {
        FrameLayout placeholder = new FrameLayout(this);
        placeholder.setContentDescription("关闭"); placeholder.setClickable(true);
        placeholder.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentView(placeholder);
        new Handler(Looper.getMainLooper()).postDelayed(() -> startupIcon(), 4000);
    }
    private void startupIcon() {
        page("准备中");
        Dialog dialog = new Dialog(this);
        FrameLayout panel = new FrameLayout(this); panel.setId(R.id.ad_panel); panel.setBackgroundColor(Color.WHITE);
        panel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        TextView title = new TextView(this); title.setText("广告提示"); panel.addView(title, new FrameLayout.LayoutParams(400,200));
        ImageButton close = new ImageButton(this) {
            final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override protected void onDraw(Canvas canvas) {
                canvas.drawColor(Color.WHITE); ink.setColor(Color.BLACK); ink.setStrokeWidth(3 * getResources().getDisplayMetrics().density);
                canvas.drawLine(getWidth()*0.24f,getHeight()*0.24f,getWidth()*0.76f,getHeight()*0.76f,ink);
                canvas.drawLine(getWidth()*0.76f,getHeight()*0.24f,getWidth()*0.24f,getHeight()*0.76f,ink);
            }
        };
        close.setId(R.id.graphic_target); close.setBackgroundColor(Color.WHITE);
        int size = Math.round(48 * getResources().getDisplayMetrics().density);
        FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(size,size,Gravity.TOP|Gravity.RIGHT); panel.addView(close,position);
        dialog.setContentView(panel); dialog.getWindow().setLayout(Math.round(280 * getResources().getDisplayMetrics().density),Math.round(320 * getResources().getDisplayMetrics().density));
        dialog.setCancelable(false); dialog.show(); dialog.getWindow().setLayout(Math.round(280 * getResources().getDisplayMetrics().density),Math.round(320 * getResources().getDisplayMetrics().density));
        close.setOnClickListener(v -> { close.setEnabled(false); new Handler(Looper.getMainLooper()).postDelayed(() -> { dialog.dismiss(); page("Home"); button("注册新账号", R.id.open_register).setOnClickListener(w -> form()); }, 1800); });
    }
    private void form() {
        page(FIXTURE_EPSILON ? "注册新账号" : "Create test account");
        if (FIXTURE_EPSILON) label("用户名");
        user = input(FIXTURE_EPSILON ? "" : "Username", FIXTURE_EPSILON ? View.NO_ID : R.id.username, false);
        if (FIXTURE_BETA) {
            button("Next", R.id.next).setOnClickListener(v -> {
                username = user.getText().toString(); page("Password page"); passwordPage();
            });
        } else passwordPage();
    }
    private void passwordPage() {
        if (FIXTURE_EPSILON) label("密码");
        password = input(FIXTURE_EPSILON ? "" : "Password", FIXTURE_EPSILON ? View.NO_ID : R.id.password, true);
        if (FIXTURE_EPSILON) { label("确认密码"); confirmation = input("", View.NO_ID, true); }
        Button submit = button("Register", R.id.submit);
        submit.setOnClickListener(v -> {
            submit.setEnabled(false);
            if (!FIXTURE_BETA) username = user.getText().toString();
            final String name = username, pass = password.getText().toString();
            if (FIXTURE_EPSILON && !pass.equals(confirmation.getText().toString())) { page("Password mismatch"); return; }
            final String device = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            new Thread(() -> {
                String result = "UNKNOWN";
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://203.0.113.10:18080/register").openConnection();
                    c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setRequestMethod("POST"); c.setDoOutput(true);
                    c.setRequestProperty("User-Agent", "OwnedFixture/1.0");
                    c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    String payload = "username=" + URLEncoder.encode(name,"UTF-8") + "&password=" + URLEncoder.encode(pass,"UTF-8") + "&device=" + URLEncoder.encode(device,"UTF-8") + "&model=" + URLEncoder.encode(Build.MODEL,"UTF-8");
                    c.getOutputStream().write(payload.getBytes(StandardCharsets.UTF_8));
                    byte[] data = new byte[128]; int count = c.getInputStream().read(data);
                    result = count > 0 ? new String(data,0,count,StandardCharsets.UTF_8) : "UNKNOWN"; c.disconnect();
                } catch (Exception ignored) { /* A missing response never triggers another request. */ }
                final String response = result;
                runOnUiThread(() -> {
                    page("Result"); TextView text = new TextView(this);
                    text.setId("OK".equals(response) ? R.id.account_home : "REJECT".equals(response) ? R.id.rejected : R.id.pending);
                    text.setText("OK".equals(response) ? (FIXTURE_GAMMA || FIXTURE_DELTA || FIXTURE_EPSILON || FIXTURE_THETA ? "Registration successful" : "Welcome " + name) : "REJECT".equals(response) ? "Rejected" : "Pending result"); layout.addView(text);
                });
            }).start();
        });
    }
}
