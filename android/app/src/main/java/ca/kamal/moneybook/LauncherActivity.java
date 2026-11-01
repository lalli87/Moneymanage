package ca.kamal.moneybook;

import android.content.res.Configuration;
import android.net.Uri;

/**
 * Opens MoneyBook and tells it whether the phone is in dark mode (?night=1), because the browser
 * inside the app can report "light" even when the phone's dark mode is on.
 */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
  @Override
  protected Uri getLaunchingUrl() {
    Uri url = super.getLaunchingUrl();
    boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
        == Configuration.UI_MODE_NIGHT_YES;
    return url.buildUpon().appendQueryParameter("night", night ? "1" : "0").build();
  }
}
