// A small web app as someone would build it for a site of their own: files named from the root,
// fetch('/api/…') to its backend, nothing that knows where it is hosted.
const list = document.getElementById('classes');
const status = document.getElementById('status');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load() {
  const answer = await fetch('/api/classes');
  if (!answer.ok) throw new Error(`The timetable could not be read (${answer.status}).`);
  const { classes } = await answer.json();
  list.replaceChildren(...classes.map(card));
  status.hidden = true;
}

function card(item) {
  const left = Number(item.places_left);
  const row = el('li', 'class');
  const about = el('div', 'about');
  about.append(el('h2', '', item.title), el('p', 'when', item.starts), el('p', 'note', item.note));
  const side = el('div', 'side');
  const places = left < 1 ? 'Full' : `${left} place${left === 1 ? '' : 's'} left`;
  const book = el('button', '', 'Book a place');
  book.type = 'button';
  book.disabled = left < 1;
  book.addEventListener('click', () => { book.hidden = true; row.append(form(item, row)); row.querySelector('input').focus(); });
  side.append(el('strong', 'price', item.price), el('span', left < 1 ? 'left full' : left < 3 ? 'left few' : 'left', places), book);
  row.append(about, side);
  return row;
}

function form(item, row) {
  const box = el('form', 'book');
  const id = `name-${item.id}`;
  const label = el('label', '', 'Your name');
  label.htmlFor = id;
  const name = el('input');
  name.id = id; name.name = 'name'; name.required = true; name.maxLength = 80; name.autocomplete = 'name';
  const confirm = el('button', '', 'Confirm booking');
  box.append(label, name, confirm);
  box.addEventListener('submit', async (event) => {
    event.preventDefault();
    confirm.disabled = true;
    row.querySelector('.error')?.remove();
    const answer = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classId: item.id, name: name.value }) });
    if (!answer.ok) {
      const problem = await answer.json().catch(() => ({}));
      row.append(el('p', 'error', problem.error || 'The booking could not be saved. Please try again.'));
      confirm.disabled = false;
      return;
    }
    const booked = name.value.trim();
    await load();
    const fresh = [...list.children].find((entry) => entry.querySelector('h2')?.textContent === item.title);
    fresh?.append(el('p', 'done', `Thanks, ${booked}. Your place is booked.`));
  });
  return box;
}

load().catch((problem) => { status.textContent = problem.message; });
