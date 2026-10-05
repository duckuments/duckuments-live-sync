// Picker for "PULL FROM / PUSH FROM (choose remote vault)" commands.
import { App, SuggestModal } from "obsidian";
import type { RemoteVault } from "../settings";

export class VaultChooserModal extends SuggestModal<RemoteVault> {
  constructor(
    app: App,
    private vaults: RemoteVault[],
    private action: string,
    private onChoose: (v: RemoteVault) => void,
  ) {
    super(app);
    this.setPlaceholder(`${action} — choose a remote vault`);
  }

  getSuggestions(query: string): RemoteVault[] {
    const q = query.toLowerCase();
    return this.vaults.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.dbName.toLowerCase().includes(q),
    );
  }

  renderSuggestion(v: RemoteVault, el: HTMLElement): void {
    el.createDiv({ text: v.name });
    el.createEl("small", { text: `${v.couchURI} / ${v.dbName}` });
  }

  onChooseSuggestion(v: RemoteVault): void {
    this.onChoose(v);
  }
}
