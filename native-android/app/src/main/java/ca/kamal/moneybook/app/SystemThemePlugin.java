package ca.kamal.moneybook.app;

import android.content.res.Configuration;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Tells the page whether the phone's dark mode is on, and when it changes. */
@CapacitorPlugin(name = "SystemTheme")
public class SystemThemePlugin extends Plugin {
  private boolean night() {
    return (getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
  }

  @PluginMethod
  public void get(PluginCall call) {
    JSObject r = new JSObject();
    r.put("night", night());
    call.resolve(r);
  }

  void changed(Configuration cfg) {
    JSObject r = new JSObject();
    r.put("night", (cfg.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
    notifyListeners("change", r);
  }

  @Override
  protected void handleOnResume() {
    JSObject r = new JSObject();
    r.put("night", night());
    notifyListeners("change", r);
  }
}
