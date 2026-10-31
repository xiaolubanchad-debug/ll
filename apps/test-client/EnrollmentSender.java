package com.apkplatform.testclient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLException;

/** One persisted, idempotent owned-client request; never used for product registration. */
public final class EnrollmentSender {
  public interface Listener {
    void status(String code);
    void accepted(String response) throws Exception;
  }
  private final long totalMs, attemptMs, retryMs;
  private final int attempts;
  private final AtomicBoolean cancelled = new AtomicBoolean();
  private final AtomicReference<HttpURLConnection> active = new AtomicReference<>();
  private volatile Thread worker;
  private volatile ScheduledExecutorService deadlines;

  public EnrollmentSender() { this(9000, 2500, 4, 150); }
  // Package-private, shorter budgets exercise real stalled sockets in JVM boundary tests.
  EnrollmentSender(long totalMs, long attemptMs, int attempts, long retryMs) {
    if (totalMs < 1 || attemptMs < 1 || attempts < 1 || retryMs < 0)
      throw new IllegalArgumentException("INVALID_BUDGET");
    this.totalMs = totalMs; this.attemptMs = attemptMs;
    this.attempts = attempts; this.retryMs = retryMs;
  }
  private static long now() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }
  private void check(long deadline) throws IOException {
    if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new IOException("CANCELLED");
    if (now() >= deadline) throw new SocketTimeoutException();
  }
  public void cancel() {
    cancelled.set(true);
    Thread thread = worker;
    if (thread != null) thread.interrupt();
    ScheduledExecutorService executor = deadlines;
    HttpURLConnection connection = active.get();
    if (executor != null && connection != null) {
      try { executor.execute(connection::disconnect); } catch (RejectedExecutionException ignored) { }
    }
  }
  public void send(URL url, String token, String ua, String body, Listener listener) {
    if (cancelled.get()) return;
    worker = Thread.currentThread();
    ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(task -> {
      Thread thread = new Thread(task, "owned-test-network-deadline");
      thread.setDaemon(true); return thread;
    });
    deadlines = executor;
    final long end = now() + totalMs;
    final byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    try {
      for (int attempt = 0; attempt < attempts && !cancelled.get(); attempt++) {
        if (now() >= end || Thread.currentThread().isInterrupted()) return;
        HttpURLConnection connection = null;
        ScheduledFuture<?> timeout = null;
        AtomicBoolean expired = new AtomicBoolean();
        long attemptEnd = Math.min(end, now() + attemptMs);
        try {
          check(end);
          connection = (HttpURLConnection) url.openConnection();
          active.set(connection);
          final HttpURLConnection current = connection;
          int budget = (int)Math.max(1, Math.min(Integer.MAX_VALUE, attemptEnd - now()));
          timeout = executor.schedule(() -> {
            expired.set(true); current.disconnect();
          }, budget, TimeUnit.MILLISECONDS);
          connection.setRequestMethod("POST");
          connection.setInstanceFollowRedirects(false);
          connection.setUseCaches(false);
          connection.setConnectTimeout(budget);
          connection.setReadTimeout(budget);
          connection.setRequestProperty("Authorization", "Bearer " + token);
          connection.setRequestProperty("Content-Type", "application/json");
          connection.setRequestProperty("User-Agent", ua);
          connection.setRequestProperty("Connection", "close");
          connection.setDoOutput(true);
          connection.setFixedLengthStreamingMode(bytes.length);
          check(attemptEnd);
          try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
          check(attemptEnd);
          int status = connection.getResponseCode();
          check(attemptEnd);
          if (status == 200) {
            String response = read(connection.getInputStream(), attemptEnd);
            if (expired.get()) throw new SocketTimeoutException();
            check(attemptEnd);
            listener.accepted(response);
            if (!cancelled.get()) listener.status("HTTP_200");
            return;
          }
          if (status < 100 || status > 599) throw new IOException("INVALID_STATUS");
          if (!cancelled.get()) listener.status("HTTP_" + status);
          if (status < 500) return;
        } catch (Exception error) {
          if (cancelled.get() || Thread.currentThread().isInterrupted()) return;
          listener.status(expired.get() || error instanceof SocketTimeoutException ? "NETWORK_TIMEOUT"
              : error instanceof SSLException ? "NETWORK_TLS"
              : error instanceof ConnectException ? "NETWORK_CONNECT" : "NETWORK_ERROR");
        } finally {
          if (timeout != null) timeout.cancel(false);
          active.compareAndSet(connection, null);
          if (connection != null) connection.disconnect();
        }
        if (attempt + 1 == attempts || cancelled.get()) return;
        long remaining = end - now();
        if (remaining <= retryMs) return;
        try { Thread.sleep(retryMs); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); return; }
      }
    } finally {
      deadlines = null;
      executor.shutdownNow();
      worker = null;
    }
  }
  private String read(InputStream source, long deadline) throws IOException {
    try (InputStream in = source; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[2048];
      while (true) {
        check(deadline);
        int count = in.read(buffer);
        check(deadline);
        if (count == -1) return new String(out.toByteArray(), StandardCharsets.UTF_8);
        if (out.size() + count > 16384) throw new IOException("TOO_LARGE");
        out.write(buffer, 0, count);
      }
    }
  }
}
