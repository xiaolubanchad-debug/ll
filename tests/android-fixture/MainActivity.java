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
import android.view.View;
import android.view.MotionEvent;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

// Owned acceptance APK only. No production app or third-party service is contacted.
public final class MainActivity extends Activity {
    private String username = "";
    private LinearLayout layout;
    private EditText user, password;
    private void page(String title) {
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 64, 32, 32); TextView heading = new TextView(this);
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
    private void form() {
        page("Create test account"); user = input("Username", R.id.username, false);
        if (FIXTURE_BETA) {
            button("Next", R.id.next).setOnClickListener(v -> {
                username = user.getText().toString(); page("Password page"); passwordPage();
            });
        } else passwordPage();
    }
    private void passwordPage() {
        password = input("Password", R.id.password, true);
        Button submit = button("Register", R.id.submit);
        submit.setOnClickListener(v -> {
            submit.setEnabled(false);
            if (!FIXTURE_BETA) username = user.getText().toString();
            final String name = username, pass = password.getText().toString();
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
                    text.setText("OK".equals(response) ? (FIXTURE_GAMMA || FIXTURE_DELTA ? "Registration successful" : "Welcome " + name) : "REJECT".equals(response) ? "Rejected" : "Pending result"); layout.addView(text);
                });
            }).start();
        });
    }
}
