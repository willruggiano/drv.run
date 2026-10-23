import { installDrafts } from "./hypermedia-drafts.ts";
import { installAttachments } from "./hypermedia-attachments.ts";
import { installCompletions } from "./hypermedia-completions.ts";
import { installSearch } from "./hypermedia-search.ts";
import { installKeys } from "./hypermedia-keys.ts";
import { installSettings } from "./hypermedia-settings.ts";
import { installPwa } from "./hypermedia-pwa.ts";
import { installStream } from "./hypermedia-stream.ts";

installDrafts();
installAttachments();
installCompletions();
installSearch();
installKeys();
installSettings();
installPwa();
installStream();
