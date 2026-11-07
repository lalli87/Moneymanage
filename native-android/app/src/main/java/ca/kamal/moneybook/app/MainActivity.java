package ca.kamal.moneybook.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

// Hands Google's "allow access to Drive / Calendar" result back to the sign-in plugin.
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SystemThemePlugin.class);
    super.onCreate(savedInstanceState);
  }

  @Override
  public void onConfigurationChanged(Configuration cfg) {
    super.onConfigurationChanged(cfg);
    PluginHandle h = getBridge() != null ? getBridge().getPlugin("SystemTheme") : null;
    if (h != null && h.getInstance() instanceof SystemThemePlugin) ((SystemThemePlugin) h.getInstance()).changed(cfg);
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
      PluginHandle handle = getBridge().getPlugin("SocialLogin");
      if (handle == null) return;
      Plugin plugin = handle.getInstance();
      if (plugin instanceof SocialLoginPlugin) ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }
  }

  @Override
  public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
