import { describe, expect, it } from 'vitest';
import { adoptIds, designProblems } from './databaseDesign';
import { readMermaid, toMermaid } from './mermaidErd';
import { importSql } from './sqlSchema';
import { POSTS_MERMAID, SHOP_MYSQL, summary } from './__fixtures__/schemas';

describe('a Mermaid ER diagram', () => {
  it('reads one written by hand: its entities as tables, its keys, and each relationship with many at one end as a connection', () => {
    const read = readMermaid(POSTS_MERMAID, 'members');
    expect(read.problems).toEqual([]);
    expect(summary(read.design!)).toEqual([
      { name: 'author', fields: ['name:text!', 'email:text unique'], links: [] },
      { name: 'post', fields: ['title:text!', 'body:text', 'published:boolean =no'], links: ['author_id→author! cascade'] },
      { name: 'comment', fields: ['name:text', 'message:text!'], links: ['post_id→post! cascade'] },
    ]);
    expect(read.notes).toEqual(['author: its key author_id is its id here.']);
    expect(designProblems(read.design!)).toEqual([]);
  });

  it('writes a design and reads it back as it was', () => {
    const shop = importSql(SHOP_MYSQL).design;
    const text = toMermaid(shop);
    expect(text).toContain('  orders {\n    integer id PK\n    choice status "required; default: new; one of: new, paid, shipped, cancelled"\n    date placed_on\n    integer customer_id FK "required"\n  }');
    expect(text).toContain('  customers ||--o{ orders : customer_id');
    const read = readMermaid(text);
    expect(read.problems).toEqual([]);
    // What Mermaid cannot say (what removing a row does, each pair once) comes back from the design it was written from.
    expect(summary(adoptIds(shop, read.design!, true))).toEqual(summary(shop));
  });

  it('adds a table for two entities with many of each other, reads Mermaid’s words for the ends, and one to one as one each', () => {
    const read = readMermaid('erDiagram\n  STUDENT }o--o{ COURSE : takes\n  CUSTOMER only one to zero or more ORDER : places\n  PERSON ||--|| PASSPORT : holds');
    expect(summary(read.design!)).toEqual([
      { name: 'student', fields: [], links: [] },
      { name: 'course', fields: [], links: [] },
      { name: 'customer', fields: [], links: [] },
      { name: 'orders', fields: [], links: ['customer_id→customer! cascade'] },
      { name: 'person', fields: [], links: [] },
      { name: 'passport', fields: [], links: ['person_id→person! cascade one'] },
      { name: 'student_course', fields: [], links: ['student_id→student! cascade', 'course_id→course! cascade'], stamped: true, pairs: true },
    ]);
    expect(read.notes).toEqual([
      'ORDER is called orders here.',
      'student and course have many of each other: the table student_course keeps which goes with which.',
    ]);
  });

  it('keeps a one to one connection on the side its column is on, or the side there may be none of', () => {
    const read = readMermaid([
      'erDiagram',
      '  profile |o--|| account : belongs',
      '  account ||--o| settings : has',
      '  badge ||--|| holder : given',
      '  holder {',
      '    integer badge_id FK',
      '  }',
    ].join('\n'));
    expect(summary(read.design!)).toEqual([
      { name: 'profile', fields: [], links: ['account_id→account! cascade one'] },
      { name: 'account', fields: [], links: [] },
      { name: 'settings', fields: [], links: ['account_id→account! cascade one'] },
      { name: 'badge', fields: [], links: [] },
      { name: 'holder', fields: [], links: ['badge_id→badge! cascade one'] },
    ]);
    const back = readMermaid(toMermaid(read.design!));
    expect(summary(back.design!)).toEqual(summary(read.design!));
  });

  it('writes defaults and choices with any marks in them, and reads them back as they were', () => {
    const read = readMermaid('erDiagram\n  NOTE {\n    text greeting "default: Hi%3B there%2C you"\n    choice size "one of: S%2C small, M %22medium%22, 50%25"\n  }');
    expect(summary(read.design!)[0].fields).toEqual(['greeting:text =Hi; there, you', 'size:choice [S, small|M "medium"|50%]']);
    const back = readMermaid(toMermaid(read.design!));
    expect(summary(back.design!)).toEqual(summary(read.design!));
  });

  it('reads what Mermaid’s own editor writes: settings, aliases, classes, descriptions, words and symbols without spaces', () => {
    const read = readMermaid([
      '---',
      'title: Library',
      'config:',
      '  theme: forest',
      '---',
      'erDiagram',
      '  accTitle: A library',
      '  accDescr {',
      '    Members borrow books',
      '  }',
      '  m["Library member"]:::people {',
      '    string prénom',
      '    int book_count',
      '  }',
      '  b[Book] { string title }',
      '  l[Loan]',
      '  dbo.Shelves { int id PK }',
      '  m||--o{l:borrows %% a comment after it',
      '  b only one -- zero or more l : lent',
      '  dbo.Shelves |o..o{ b : holds',
      '  l {',
      '    int member_id',
      '  }',
    ].join('\n'));
    expect(read.problems).toEqual([]);
    expect(summary(read.design!)).toEqual([
      { name: 'library_member', fields: ['prenom:text', 'book_count:integer'], links: [] },
      { name: 'book', fields: ['title:text'], links: ['shelf_id→shelves setNull'] },
      { name: 'loan', fields: [], links: ['member_id→library_member! cascade', 'book_id→book! cascade'] },
      { name: 'shelves', fields: [], links: [] },
    ]);
  });

  it('says by line what stops it being read, and makes nothing of it', () => {
    expect(readMermaid('graph TD\n  A --> B').problems[0]).toEqual({ line: 1, text: 'A Mermaid ER diagram starts with erDiagram, on a line of its own.' });
    const read = readMermaid('erDiagram\n  CAT {\n    string name\n    this is not an attribute\n  }\n  CAT likes DOG\n  DOG {\n    int id PK');
    expect(read.design).toBeNull();
    expect(read.problems.map(problem => problem.line)).toEqual([4, 6, 7]);
    expect(read.problems[2].text).toBe('DOG’s { is not closed with }.');
  });

  it('keeps a default it can, and says why it leaves one out', () => {
    const read = readMermaid('erDiagram\n  ITEM {\n    integer count "default: many"\n    decimal price "required; default: 9.95"\n  }');
    expect(summary(read.design!)).toEqual([{ name: 'item', fields: ['count:integer', 'price:decimal! =9.95'], links: [] }]);
    expect(read.notes).toEqual(['item.count: its default many is left out: the default must be a whole number.']);
  });
});
