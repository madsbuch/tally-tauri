use serde::{de::DeserializeOwned, Deserialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{NotifyCheckinArgs, ScheduleCheckinArgs};

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.coach";

/// `takeOpenedCheckin`'s answer: `{}` when nothing was tapped.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenedCheckin {
    chat_id: Option<i64>,
}

/// `notifyCheckin`'s answer.
#[derive(Deserialize)]
struct NotifyCheckinResult {
    posted: bool,
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Coach<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CoachPlugin")?;
    Ok(Coach(handle))
}

/// Access to the Android alarm that runs the daily check-in, and to the
/// check-in notification.
pub struct Coach<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Coach<R> {
    pub fn schedule_checkin(&self, args: ScheduleCheckinArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("scheduleCheckin", args)?;
        Ok(())
    }

    pub fn cancel_checkin(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("cancelCheckin", ())?;
        Ok(())
    }

    pub fn take_opened_checkin(&self) -> crate::Result<Option<i64>> {
        let opened = self
            .0
            .run_mobile_plugin::<OpenedCheckin>("takeOpenedCheckin", ())?;
        Ok(opened.chat_id)
    }

    pub fn notify_checkin(&self, args: NotifyCheckinArgs) -> crate::Result<bool> {
        let result = self
            .0
            .run_mobile_plugin::<NotifyCheckinResult>("notifyCheckin", args)?;
        Ok(result.posted)
    }
}
