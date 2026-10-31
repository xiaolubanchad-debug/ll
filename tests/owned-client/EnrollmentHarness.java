package com.apkplatform.testclient;

import java.io.IOException;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class EnrollmentHarness {
  public static void main(String[] args) throws Exception {
    EnrollmentSender sender = new EnrollmentSender(950, 260, 4, 25);
    List<String> statuses = new ArrayList<>();
    boolean[] confirmed = {false};
    int[] accepted = {0};
    ScheduledExecutorService killer = Executors.newSingleThreadScheduledExecutor();
    if ("cancel".equals(args[1])) killer.schedule(sender::cancel, 120, TimeUnit.MILLISECONDS);
    if ("pre-cancel".equals(args[1])) sender.cancel();
    long began = System.nanoTime();
    try {
      sender.send(new URL(args[0]), "owned-fixture-token", "OwnedFixture/1.0",
          "{\"installationId\":\"owned-installation\",\"requestKey\":\"same-request\"}",
          new EnrollmentSender.Listener() {
            @Override public void status(String code) { statuses.add(code); }
            @Override public void accepted(String body) throws Exception {
              accepted[0]++;
              if (!"CONFIRMED".equals(body)) throw new IOException("INVALID_REPLY");
              confirmed[0] = true;
            }
          });
    } finally { killer.shutdownNow(); }
    long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - began);
    long successes = statuses.stream().filter("HTTP_200"::equals).count();
    String last = statuses.isEmpty() ? "NONE" : statuses.get(statuses.size() - 1);
    System.out.println("{\"confirmed\":" + confirmed[0] + ",\"successFlags\":" + successes
        + ",\"elapsedMs\":" + elapsed + ",\"acceptedCallbacks\":" + accepted[0]
        + ",\"lastStatus\":\"" + last + "\"}");
  }
}
