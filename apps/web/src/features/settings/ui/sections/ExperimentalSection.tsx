import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { SettingsSectionProps } from "./types";

export function ExperimentalSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <FieldGroup className="gap-5">
      <div>
        <h3 className="text-base font-semibold">Experimental</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Early-access features that are still in development.
        </p>
      </div>

      {/* Browser */}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="experimental-browser" className="text-sm">
            Browser
          </FieldLabel>
          <FieldDescription>
            Let the AI agent use a browser to test and develop websites.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="experimental-browser"
          checked={settings.experimental_browser === true}
          onCheckedChange={(checked) => saveSetting("experimental_browser", checked)}
        />
      </Field>
    </FieldGroup>
  );
}
