export type CopyField = 'command' | 'cwd' | 'id';

export type WebviewMessage = {
  commandId?: string;
  copyField?: CopyField;
  type: 'clear' | 'copy' | 'delete' | 'kill' | 'ready' | 'select';
};

export type ReplaceOutputWebviewMessage = {
  commandId: string;
  isRunning: boolean;
  outputHtml: string;
  type: 'replaceOutput';
};

export type ReplacePanelStateWebviewMessage = {
  commandItemsHtml: string;
  detailsHtml: string;
  type: 'replacePanelState';
};

export type ExtensionWebviewMessage = ReplaceOutputWebviewMessage | ReplacePanelStateWebviewMessage;
