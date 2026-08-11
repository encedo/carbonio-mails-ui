# Port PGP na nowy edytor (Lexical)

Stan: plan przyjęty 2026-08-11, po sync do upstream v1.41.1 (`ae11cad6`).

## Kontekst

Upstream w 1.41 rozbił widok kompozycji na dwa drzewa:

- `src/views/app/detail-panel/edit/editor/` — nowy edytor Lexical, **domyślny**
- `src/views/app/detail-panel/edit/legacyEditor/` — stary TinyMCE, pod niego pisany jest nasz PGP

Wybór robi `edit-view-controller.tsx` przez `useLegacyEditor()`, a ten czyta
`localStorage['carbonio-mails-ui_legacyEditor']` z domyślną wartością `false`. Nie ma
przełącznika w UI. Skutek: **przyciski PGP są dziś niewidoczne przy domyślnych ustawieniach.**

## Ustalenia, które decydują o skali

Zbadane w kodzie, nie założone:

1. **Kontrakt store'a jest ten sam.** `editor/plugins/controlled-content-plugin.tsx` robi
   `useEditorsStore.getState().setText(editorId, { plainText, richText })` — to samo pole co
   TinyMCE. Push jest **synchroniczny** przy każdej zmianie; debounce dotyczy tylko `saveDraft`.

2. **Nasze pobieranie treści już działa na nowym edytorze.** W `use-send-handlers.ts` mamy
   `editor.textProvider?.getCurrentText()?.richText ?? editor.text?.richText ?? ''`.
   Lexical (rich text) **nie** rejestruje `textProvider`, więc łańcuch spada na `editor.text`,
   utrzymywany świeżo przez plugin. Plain-text container prowider rejestruje. Oba przypadki
   obsłużone bez zmian w naszym kodzie.

3. **Obrazki inline przeżyją.** `editor/plugins/nodes/image-node.tsx` w `exportDOM` zapisuje cid
   do `data-pnsrc` **i** `data-mce-src`; nasz `rewriteInlineImagesToCid` czyta m.in.
   `data-mce-src`. Do dopisania jedynie `data-pnsrc` dla pewności.

4. **Oba `edit-view.tsx` to prawie klony** — różnią się ok. 60 liniami (gating wysyłki przeniesiony
   do `edit-view-send-buttons`, które bierze teraz `editorId`). `GapRow` z „Add attachment",
   gdzie siedzą nasze przyciski, jest identyczny.

## Decyzja architektoniczna

**Nie duplikować PGP do obu drzew.** Wspólne części wychodzą z `legacyEditor/` do neutralnej
lokalizacji, oba edit-view importują to samo. Nasze pliki PGP nie mają zależności legacy — używają
wyłącznie aliasów (`commons/…`, `store/editor`, `types/editor`), więc przenoszą się czysto.

Zysk: jedna implementacja do utrzymania teraz; gdy Zextras skasuje `legacyEditor`, nie ma czego
przenosić.

## Kroki

1. **Hoist** `pgp-send.ts`, `use-pgp-handlers.tsx`, `pgp-buttons.tsx` + test do wspólnego modułu;
   w `legacyEditor/` zostają tylko importy.
2. **UI** — `<PgpButtons editorId={editorId} />` do `editor/edit-view.tsx`, w ten sam `GapRow`
   przed `AddAttachmentsDropdown`.
3. **Send path** — przenieść gałąź PGP do `editor/edit-utils-hooks/use-send-handlers.ts`. Jedyny
   nietrywialny plik: nowa kopia ma dodatkowo `onSendStart`, więc nie da się jej podmienić hurtem.
   Wpleść nasz blok: sign/encrypt → `buildSignedEml`/`buildEncryptedMp` → `uploadRawMime` →
   SendMsg z `aid`.
4. **`data-pnsrc`** dopisać do listy atrybutów w `rewriteInlineImagesToCid`.
5. **Testy** — `use-pgp-handlers.test.tsx` jest store'owy, przechodzi po hoiście; dołożyć przypadek
   send-path w `editor/tests/`.

## Czego NIE trzeba ruszać

- Guard przed zapisem plaintext draftu (`store/editor/hooks/save-draft.ts`) i cache załączników
  siedzą we **współdzielonym** store — obejmą nowy edytor automatycznie.
- Cała strona odczytu (`mail-message-renderer`, `pgp-message-view`, `normalize-message`,
  sanityzacja XSS) jest niezależna od edytora.

## Ryzyka

- **`keepOnlyInlineAttachments(usedCids)`** leci przy każdej zmianie treści w nowym edytorze
  i przycina załączniki, których cid-ów nie ma w HTML-u. Główny punkt styku z naszym gromadzeniem
  załączników do szyfrowania — wart osobnego testu.
- **Gating wysyłki** przeniesiono do `edit-view-send-buttons` (bierze `editorId`). Blokada wysyłki
  przy fingerprint mismatch wpina się tam, nie w `edit-view`.
- **Upstream wciąż refaktoruje**: `editor/lexical-editor-container.tsx` istnieje, ale jest
  importowany wyłącznie przez własny test — martwy kod. Te pliki mogą się jeszcze ruszyć.
