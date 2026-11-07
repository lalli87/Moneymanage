package ca.kamal.moneybook.app;

import android.accounts.Account;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import java.util.ArrayList;
import java.util.List;

/**
 * Gets a Google access token for the account you sync with, without showing the account picker,
 * once you've allowed MoneyBook access. If Google needs you to confirm, it says so and the app
 * falls back to the normal sign-in.
 */
@CapacitorPlugin(name = "DriveAuth")
public class DriveAuthPlugin extends Plugin {
  @PluginMethod
  public void token(PluginCall call) {
    String email = call.getString("email");
    JSArray arr = call.getArray("scopes");
    if (email == null || email.isEmpty() || arr == null) { call.reject("missing email or scopes"); return; }
    List<Scope> scopes = new ArrayList<>();
    try { for (int i = 0; i < arr.length(); i++) scopes.add(new Scope(arr.getString(i))); } catch (Exception e) { call.reject("bad scopes"); return; }
    AuthorizationRequest req = AuthorizationRequest.builder()
        .setRequestedScopes(scopes)
        .setAccount(new Account(email, "com.google"))
        .build();
    Identity.getAuthorizationClient(getContext()).authorize(req)
        .addOnSuccessListener(res -> {
          if (res.hasResolution() || res.getAccessToken() == null) { call.reject("needs-consent"); return; }
          JSObject r = new JSObject();
          r.put("token", res.getAccessToken());
          call.resolve(r);
        })
        .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "failed" : e.getMessage()));
  }
}
