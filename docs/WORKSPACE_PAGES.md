# Workspace pages

How a signed-in page of FormLogic is laid out: Home, Forms, Apps, an app's own page, the App
Studio, Settings, the admin area, the recycle bin. Every one of them follows the same few rules,
so a person who has learned one page has learned the rest. The pieces are in
`formlogic/ui/src/components`.

## The frame

A page is a `Header` (`layout/Header`) with the page's name, and a body under it. The body starts
on the same line as the name and takes the width it is given:

```tsx
import { PageBody } from '../components/layout/PageBody';

<Header title="Settings" />
<PageBody>…</PageBody>
```

`PageBody` is `w-full px-4 pb-24 pt-4 sm:px-6`: the header's own gutter. A page whose body is
already an element of its own takes the classes from `PAGE_BODY` or the gutter from `PAGE_GUTTER`.

No page centres itself in a column (`mx-auto max-w-…`). Lists and tables fill the width. Settings
flow into more columns as the screen widens. A form keeps a readable width of its own, at the
left; on a wide screen what leads to the form stands beside it (Create app).

A page is called by one name everywhere: the navigation, the header and the browser tab say
"Home", not "Home" and "Dashboard".

## Sections

A page with sections shows them as one row of links under the header:

```tsx
import { SectionNav } from '../components/ui/SectionNav';

<SectionNav label="App sections" current={section}
  items={[{ value: 'data', label: 'Data', icon: Database, to: softnWorkspacePath(app.id, 'data'), mark: 8 }, …]}
  end={statusLine} />
```

They are links, not tabs. Each section is an address (a part of the path, or the `#hash` on a
page that already used one), so it opens in a new tab, a copied link lands on it, a reload stays
on it and Back returns to it. On a phone the names stand without their icons at a finger's
height, and the row scrolls sideways before it wraps. `mark` is a count beside a name; `end` is
what the page says at the row's right, such as an app's state.

There is no banner over a section: no eyebrow line, no title repeating the section's name, no
"step 2 of 6". Where a sentence of help is needed it is one muted line.

An app's own page (`pages/apps/SoftnAppWorkspace.tsx`, a SoftN or a JavaScript app) has these
sections, named in `SOFTN_SECTIONS` (`lib/softnApps.ts`): Overview, Data, Members, Edit,
Automations, History, Domains and Settings. Members and History are shown to the app's owner
alone, and Automations to the owner of an app that has a backend.

History (`components/apps/SoftnHistory.tsx`) lists every version a later one replaced, newest
first, each with who made it, how and what it changed. A version opens at its own address
(`…/history/7`), beside the list on a wide screen and in its place on a phone, and shows what
differs from the app now file by file; a text file opens in place (`?file=…`) with its two
versions side by side where its box has room and one above the other where it has not. Going
back asks first and says what will happen, including that the settings kept in the app's files
go back too (it names the outside sites of each when they differ); pins keep a version past the
newest thirty. Each earlier version has "Remove from history", which asks first and says that
the version's files are deleted from the history, that the app as it is now is not changed, and
that it cannot be undone; a pinned version is unpinned first. The list also says where a version
was not kept (it could not be saved in the history when it was replaced), where one is damaged (it
cannot be gone back to, and can be removed), and where the history could not be read.

A page that stays mounted across its sections must not be remounted by the route boundary:
`lib/pagePlace.ts` gives every address of such a page one key (see `App.tsx`).

## Panels

A group of settings or facts is a `Panel` (`ui/Panel`): a bordered box with a small title, an
optional line under it and optional actions at the title's right. An `id` makes it a place a
link can land on (`/settings#security`); it stops below the sticky header.

The page lays its panels out. `PANEL_COLUMNS` flows them into one column on a phone, two on a
laptop and three on a wide screen, each as tall as what it holds. Equal cards use a grid. A
panel that holds a wide table spans the columns (`[column-span:all]`).

## Lists

A list of things is a table: rows 36 to 40 px tall, a small uppercase header row, hairline
dividers, numbers in tabular figures, addresses and ids in a mono face, actions as icon buttons
at the row's right. The name column takes the spare width, so a name is not cut short while
there is room. Below a container width of `@xl` the same rows are cards (the name on top, the
other values as name-over-value pairs); nothing scrolls sideways.

`components/apps/AppsTable.tsx` is the model. It sizes itself by container queries
(`@container/list`), because the sidebar and a docked chat take their share of the window. Home
shows the same table for the apps changed most recently (`sortable={false}`, no `onDelete`).

`components/ui/listLook.ts` holds the look as class constants for any other list (the admin
users, the recycle bin, the health checks): one set of rows that is a table with room and
cards without, so nothing is drawn twice. `ROW_BOX`, `TOOL_ROW` and `LINK_ROW` are the short
lists inside a panel, where there is no room for columns.

A database is browsed with the data manager (`components/data`), on a SoftN app's page and in
the "Native app hosting" dialog alike.

A project's files are edited in the source pane (`components/studio/ProjectSourcePane.tsx`,
rules in `lib/projectSource.ts`): every file in one list, grouped by what it is for, beside
the editor. A SoftN app's page opens it alone, as "Source code"; the App Studio's "Native app
hosting" dialog, which a forms app that carries a project still uses, has it under its Source
tab beside Project and Records. A SoftN app's page never sends its owner to the App Studio: an
address of the studio that names one lands on the matching section of the app's page
(`softnPathForStudio`).

## A row of sections on a phone

`components/ui/SectionNav.tsx` is one line at every width. When it is longer than the screen it
scrolls sideways, keeps the open section in view, and says there is more: the end it runs off
fades out under an arrow that moves it along. The arrows are for a finger or a mouse (not in the
tab order, hidden from a screen reader): the links are the navigation.

`components/ui/DataTable.tsx` is the table a running forms app shows its members (a form's
records) and the App Studio shows for an app's users. It fits as many columns as its width
allows and becomes cards on a phone: each column's name over its value, two to a line, the
first column as the card's title. Rows are about 36 px, 25 to a page.

## Editors

The form builder, the flow editor and the diagram canvas are tools that take the window: a
palette, a canvas, a properties panel. They keep that shape, and:

- A name is never cut short in a palette: a long one wraps, or its tile gives it room.
- A palette row is compact: the name and one line of what it does. The long account is in its
  popover.
- One side panel is open at a time, and a panel does not become a sheet over the whole window
  on a wide screen.
- A toolbar groups what belongs together and turns labels into icons by the room it really has
  (container queries); it never drops a control.
- On a phone the canvas keeps the screen; the palette and the properties are sheets.

Where these live:

- **Form builder** (`pages/FormBuilder.tsx`, `components/builder`). The window does not scroll;
  the palette, the canvas and the field settings each scroll on their own. A field is a row of
  about 56 px (`SortableFieldCard`). The top bar is three groups (how the form looks, how it
  behaves, preview and share) and Publish; its labels give way to icons group by group by the
  bar's own width, and under 700 px the first two groups move into the "more" menu
  (`builderChrome.ts`). Its dialogs share one frame (`builderDialog.ts`).
- **Flow editor** (`components/flows/editor`). Triggers, Run history and Test run are drawn
  inside the editor, under its bar, and give way to a selected step's properties; the step list
  gives way before either (`flowEditorLogic.ts` decides by the editor's width). The list of
  flows reads each row's triggers once (`GET /api/flows/{id}/bindings`, three at a time) and
  keeps them, so opening a flow from the list does not read them again.
- **Diagram canvas** (`pages/diagrams`). The timeline and the selection panel give way to each
  other; on a phone the tools are a named list behind "Add".

Two slips to look for, found more than once: `line-clamp-N` beside `block` on one element never
clamps (`block` overrides the display the clamp needs), and a floating thing in a bottom corner
(a minimap, a pager) ends up under the chat button, which lives in the right one.

Nothing of the workspace's own floats over a page's left corner. The desktop's state ("No
desktop", "Connect OAIY", a linked desktop's name) is a line at the foot of the sidebar, beside
where the data is kept (`DesktopConnectionPopover placement="sidebar"`); its panel opens from
there. A phone has no sidebar: there it is a chip over the page, shown only while a desktop is
linked, and never on a page that claims the bottom edge (`lib/bottomEdgeClaim`).

## An app's icon

Wherever an app is listed or named (the apps table and cards, Home, the sidebar, a phone's menu,
an app's own page header, App Studio), it is drawn by `AppTile`: the owner's logo, else a SoftN
app's own icon, else a curated icon, else the app's initial. A SoftN app's own icon is the one its
browser tab and home screen show (the owner's choice in Look and sharing, else its manifest's
`icon`): the server names it on every app it lists (`lookIcon`, see HOSTED_APPS.md) and
`appIconUrl` (`lib/appLook`) gives its address. It is drawn whole and on no plate, since it is a
finished icon; a logo, which may be any picture, fills the tile.

## Colour

The accent is `primary-*`: indigo in the light theme, lime in the dark one (`index.css`). A
literal `indigo-*` class is right by day and off-colour by night, so it is used only for a
colour swatch that offers indigo by name. On a solid `bg-primary-600` the text is
`text-primary-foreground`, never `text-white`: white on lime cannot be read.

A plain radio button, tick box or slider inside the workspace takes the accent too
(`accent-primary-*` on `AppShell`).

## Phones

No page scrolls sideways from 360 px up. A control a finger presses is at least 44 px
(`min-h-11`, or `max-sm:min-h-11` where a mouse gets a smaller one). A bar fixed to the bottom
clears the phone's navigation (`--fl-mobile-reserve` in `index.css`). A page is looked at 360,
390, 430, 768, 1024, 1440 and 1920 px wide, in both themes, before it is called done.

## Who is a newcomer

Home welcomes an account that has neither a form nor an app, and offers it a form, an app and a
template side by side. An owner who hosts apps and has no forms is no newcomer: their apps come
first, and forms are one line. A read of the apps that failed, or has not answered yet, is not
"no apps".

On the Forms page an app is listed as a place for forms when it holds some, or when it is a
forms app. A hosted SoftN app without forms is not listed there, and is not asked for its forms.
