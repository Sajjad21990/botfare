// Spike 01: can we get a sandbox OAuth token with our app credentials?
import { fail, pass, paypalFromEnv } from "./_env";

const paypal = paypalFromEnv();

try {
  const token = await paypal.getAccessToken();
  pass(`got a sandbox access token (${token.slice(0, 8)}...)`);
} catch (error) {
  fail("could not get a sandbox access token", error, [
    "Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are the Sandbox (not Live) credentials.",
  ]);
}
