// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useNodeGroupStore } from './nodeGroupStore';

/**
 * User palette groups. The rules that matter are the ones that decide where a node ENDS UP,
 * because a node that quietly appears twice — or quietly disappears — is worse than no
 * organisation at all.
 */
describe('nodeGroupStore', () => {
  beforeEach(() => {
    useNodeGroupStore.setState({ groups: [] });
  });

  it('creates a group and files a node into it', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const id = createGroup('Voice')!;
    expect(id).toBeTruthy();

    useNodeGroupStore.getState().assignNode('com.acme.speak', id);
    expect(useNodeGroupStore.getState().groupOf('com.acme.speak')?.name).toBe('Voice');
  });

  it('a node lives in at most one group — filing it again MOVES it', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const voice = createGroup('Voice')!;
    const text = createGroup('Text')!;

    useNodeGroupStore.getState().assignNode('com.acme.speak', voice);
    useNodeGroupStore.getState().assignNode('com.acme.speak', text);

    const groups = useNodeGroupStore.getState().groups;
    expect(groups.find((g) => g.id === voice)!.nodeTypes).toEqual([]);
    expect(groups.find((g) => g.id === text)!.nodeTypes).toEqual(['com.acme.speak']);
  });

  it('deleting a group releases its nodes rather than hiding them', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const id = createGroup('Voice')!;
    useNodeGroupStore.getState().assignNode('com.acme.speak', id);

    useNodeGroupStore.getState().deleteGroup(id);

    // Ungrouped, which means the palette renders it in its usual section again.
    expect(useNodeGroupStore.getState().groupOf('com.acme.speak')).toBeUndefined();
    expect(useNodeGroupStore.getState().groups).toEqual([]);
  });

  it('reuses an existing group rather than creating an indistinguishable twin', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const first = createGroup('Voice')!;
    const second = createGroup('  voice  ');

    expect(second).toBe(first);
    expect(useNodeGroupStore.getState().groups).toHaveLength(1);
  });

  it('refuses an empty name', () => {
    expect(useNodeGroupStore.getState().createGroup('   ')).toBeNull();
    expect(useNodeGroupStore.getState().groups).toEqual([]);
  });

  it('reorders groups and nodes, and ignores moves past the ends', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const a = createGroup('A')!;
    const b = createGroup('B')!;

    useNodeGroupStore.getState().moveGroup(b, -1);
    expect(useNodeGroupStore.getState().groups.map((g) => g.name)).toEqual(['B', 'A']);
    // Already first — a no-op rather than an error or a wrap-around.
    useNodeGroupStore.getState().moveGroup(b, -1);
    expect(useNodeGroupStore.getState().groups.map((g) => g.name)).toEqual(['B', 'A']);

    useNodeGroupStore.getState().assignNode('one', a);
    useNodeGroupStore.getState().assignNode('two', a);
    useNodeGroupStore.getState().moveNode('two', -1);
    expect(useNodeGroupStore.getState().groups.find((g) => g.id === a)!.nodeTypes).toEqual(['two', 'one']);
  });

  it('unassigning returns a node to its default section', () => {
    const { createGroup } = useNodeGroupStore.getState();
    const id = createGroup('Voice')!;
    useNodeGroupStore.getState().assignNode('com.acme.speak', id);

    useNodeGroupStore.getState().unassignNode('com.acme.speak');
    expect(useNodeGroupStore.getState().groupOf('com.acme.speak')).toBeUndefined();
    expect(useNodeGroupStore.getState().groups[0].nodeTypes).toEqual([]);
  });

  it('caps the number of groups', () => {
    const { createGroup } = useNodeGroupStore.getState();
    for (let i = 0; i < 24; i++) expect(createGroup(`Group ${i}`)).toBeTruthy();
    expect(createGroup('One too many')).toBeNull();
    expect(useNodeGroupStore.getState().groups).toHaveLength(24);
  });
});
