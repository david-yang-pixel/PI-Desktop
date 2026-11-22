import {
  DEFAULT_CHAT_CONTENT_MAX_WIDTH,
  MIN_CHAT_CONTENT_MAX_WIDTH,
  resolveChatContentMaxWidth,
  type AppSettings,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Input } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { SettingsRow } from "../primitives";

export function ConversationWidthRow({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const width = resolveChatContentMaxWidth(settings.chatContentMaxWidth);
  const label = t("conversationDetails.width");

  return (
    <SettingsRow title={label} description={t("conversationDetails.widthDescription", {
      defaultWidth: DEFAULT_CHAT_CONTENT_MAX_WIDTH,
      minWidth: MIN_CHAT_CONTENT_MAX_WIDTH,
    })}>
      <div className="settings-number-control">
        <Input
          key={width}
          type="number"
          min={MIN_CHAT_CONTENT_MAX_WIDTH}
          step={1}
          inputMode="numeric"
          defaultValue={width}
          aria-label={label}
          onBlur={async (event) => {
            const input = event.currentTarget;
            const value = input.valueAsNumber;
            if (!Number.isSafeInteger(value) || value < MIN_CHAT_CONTENT_MAX_WIDTH) {
              input.value = String(width);
              return;
            }
            if (value === width) return;
            try {
              await saveSettings({ chatContentMaxWidth: value });
            } catch {
              input.value = String(resolveChatContentMaxWidth(useAppStore.getState().settings?.chatContentMaxWidth));
              showToast(t("conversationDetails.widthSaveError"), { variant: "error" });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}
