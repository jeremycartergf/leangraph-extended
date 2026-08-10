import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphDatabase } from '../src/db';
import { Executor } from '../src/executor';

/**
 * Pattern predicates in WHERE: (a)-[:T]->(:Label {prop: value})
 *
 * An anonymous target node carries constraints — its labels and its inline
 * property map — that have no alias in the outer query. Those constraints were
 * being dropped, so the predicate silently matched far more rows than it should
 * (and its negation matched none). See LEANGRAPH-BUG.md.
 *
 * Fixture (IS_CHILD_OF points child -> parent):
 *
 *   P1:Project
 *     <- G_carrier {containerType: 'carrier'}
 *          <- G_region {containerType: 'region'}
 *               <- G_depot {containerType: 'depot'}
 *     <- G_plain {containerType: 'depot'}
 *          <- G_other {containerType: 'depot'}
 *
 * Note every group has an outgoing IS_CHILD_OF edge, so a predicate that
 * ignores the target's label/properties matches all five.
 */
describe('WHERE pattern predicates', () => {
  let db: GraphDatabase;
  let ex: Executor;

  beforeAll(() => {
    db = new GraphDatabase(':memory:');
    db.initialize();
    ex = new Executor(db);

    const setup = ex.execute(`
      CREATE (p:Project {id: 'P1'})
      CREATE (carrier:Group {id: 'G_carrier', containerType: 'carrier'})
      CREATE (region:Group  {id: 'G_region',  containerType: 'region'})
      CREATE (depot:Group   {id: 'G_depot',   containerType: 'depot'})
      CREATE (plain:Group   {id: 'G_plain',   containerType: 'depot'})
      CREATE (other:Group   {id: 'G_other',   containerType: 'depot'})
      CREATE (carrier)-[:IS_CHILD_OF]->(p)
      CREATE (region)-[:IS_CHILD_OF]->(carrier)
      CREATE (depot)-[:IS_CHILD_OF]->(region)
      CREATE (plain)-[:IS_CHILD_OF]->(p)
      CREATE (other)-[:IS_CHILD_OF]->(plain)
    `);
    if (!setup.success) {
      throw new Error(`fixture failed: ${setup.error.message}`);
    }
  });

  afterAll(() => {
    db.close();
  });

  /** Run a query returning an `id` column and collect the ids in order. */
  function ids(cypher: string, params: Record<string, unknown> = {}): string[] {
    const result = ex.execute(cypher, params);
    if (!result.success) {
      throw new Error(`query failed: ${result.error.message}`);
    }
    return result.data.map((row) => row.id as string);
  }

  describe('variable-length', () => {
    it('applies the target label and property map', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_region']);
    });

    it('negates against the constrained target, not any reachable node', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE NOT (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_carrier', 'G_other', 'G_plain']);
    });

    it('applies a label-only target (P1 is a :Project, not a :Group)', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF*1..]->(:Group)
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_other', 'G_region']);
    });

    it('applies a property-only target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF*1..]->({containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_region']);
    });

    it('resolves a parameter in the target property map', () => {
      expect(
        ids(
          `MATCH (g:Group)
           WHERE (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: $type})
           RETURN g.id AS id ORDER BY id`,
          { type: 'carrier' },
        ),
      ).toEqual(['G_depot', 'G_region']);
    });

    it('composes with a normal predicate', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE g.containerType = 'depot'
               AND (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot']);
    });

    it('composes with a normal predicate when negated', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE g.containerType = 'depot'
               AND NOT (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_other', 'G_plain']);
    });

    it('walks incoming edges with a constrained target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)<-[:IS_CHILD_OF*1..]-(:Group {containerType: 'depot'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_carrier', 'G_plain', 'G_region']);
    });

    it('walks undirected edges with a constrained target', () => {
      expect(
        ids(`MATCH (g:Group {id: 'G_depot'})
             WHERE (g)-[:IS_CHILD_OF*1..]-(:Project)
             RETURN g.id AS id`),
      ).toEqual(['G_depot']);
    });

    it('agrees with the OPTIONAL MATCH + count workaround', () => {
      const predicate = ids(`MATCH (g:Group)
        WHERE NOT (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
        RETURN g.id AS id ORDER BY id`);
      const workaround = ids(`MATCH (g:Group)
        OPTIONAL MATCH (g)-[:IS_CHILD_OF*1..]->(anc:Group {containerType: 'carrier'})
        WITH g, COUNT(anc) AS ancestors
        WHERE ancestors = 0
        RETURN g.id AS id ORDER BY id`);
      expect(predicate).toEqual(workaround);
    });
  });

  describe('fixed-length', () => {
    // A labelled target used to splice the target check over the edge-type
    // placeholder, producing `AND e1.type =  AND EXISTS (...)`.
    it('does not generate invalid SQL for a labelled target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF]->(:Group)
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_other', 'G_region']);
    });

    it('applies the target label and property map', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_region']);
    });

    it('applies a property-only target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF]->({containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_region']);
    });

    it('negates against the constrained target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE NOT (g)-[:IS_CHILD_OF]->(:Group {containerType: 'carrier'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_carrier', 'G_depot', 'G_other', 'G_plain']);
    });

    it('applies the target label on an incoming edge', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)<-[:IS_CHILD_OF]-(:Group {containerType: 'depot'})
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_plain', 'G_region']);
    });

    it('applies the target label on an undirected edge', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF]-(:Project)
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_carrier', 'G_plain']);
    });

    it('still matches an unconstrained target', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE (g)-[:IS_CHILD_OF]->()
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_carrier', 'G_depot', 'G_other', 'G_plain', 'G_region']);
    });

    it('matches nothing for an absent relationship type', () => {
      expect(
        ids(`MATCH (g:Group) WHERE (g)-[:NO_SUCH_REL]->() RETURN g.id AS id`),
      ).toEqual([]);
    });
  });

  describe('exists()', () => {
    it('applies the target property map', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE exists((g)-[:IS_CHILD_OF]->({containerType: 'carrier'}))
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_region']);
    });

    it('applies label and property map together', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE exists((g)-[:IS_CHILD_OF]->(:Group {containerType: 'carrier'}))
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_region']);
    });

    // A hop range used to be ignored outright, collapsing *1.. to a single hop.
    it('honours a hop range instead of collapsing it to one hop', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE exists((g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'}))
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_region']);
    });

    it('agrees with the equivalent bare pattern predicate', () => {
      const viaExists = ids(`MATCH (g:Group)
        WHERE exists((g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'}))
        RETURN g.id AS id ORDER BY id`);
      const viaPredicate = ids(`MATCH (g:Group)
        WHERE (g)-[:IS_CHILD_OF*1..]->(:Group {containerType: 'carrier'})
        RETURN g.id AS id ORDER BY id`);
      expect(viaExists).toEqual(viaPredicate);
    });

    it('respects an explicit upper bound', () => {
      expect(
        ids(`MATCH (g:Group)
             WHERE exists((g)-[:IS_CHILD_OF*1..1]->(:Group {containerType: 'carrier'}))
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_region']);
    });
  });

  describe('bound target variable', () => {
    it('filters on the bound target (regression guard)', () => {
      expect(
        ids(`MATCH (g:Group), (anc:Group)
             WHERE anc.containerType = 'carrier'
               AND (g)-[:IS_CHILD_OF*1..]->(anc)
             RETURN g.id AS id ORDER BY id`),
      ).toEqual(['G_depot', 'G_region']);
    });
  });
});

/**
 * An unbounded `*` in a pattern predicate used to stop at 10 hops, so a tree
 * deeper than that silently under-matched. Termination now comes from
 * relationship uniqueness rather than a fixed depth limit, which also means
 * a cyclic graph has to terminate on its own.
 */
describe('WHERE pattern predicates over deep and cyclic graphs', () => {
  const DEPTH = 15;
  let db: GraphDatabase;
  let ex: Executor;

  beforeAll(() => {
    db = new GraphDatabase(':memory:');
    db.initialize();
    ex = new Executor(db);

    // A chain G0 <- G1 <- ... <- G15, child -> parent, 15 levels deep
    for (let i = 0; i <= DEPTH; i++) {
      ex.execute(`CREATE (:Group {id: 'G${i}', depth: ${i}})`);
    }
    for (let i = DEPTH; i > 0; i--) {
      ex.execute(
        `MATCH (a:Group {id:'G${i}'}), (b:Group {id:'G${i - 1}'})
         CREATE (a)-[:IS_CHILD_OF]->(b)`,
      );
    }

    // A 3-node cycle, disjoint from the chain
    for (const id of ['C1', 'C2', 'C3']) {
      ex.execute(`CREATE (:Cyclic {id: '${id}'})`);
    }
    for (const [from, to] of [
      ['C1', 'C2'],
      ['C2', 'C3'],
      ['C3', 'C1'],
    ]) {
      ex.execute(
        `MATCH (a:Cyclic {id:'${from}'}), (b:Cyclic {id:'${to}'})
         CREATE (a)-[:LINKS_TO]->(b)`,
      );
    }
  });

  afterAll(() => {
    db.close();
  });

  function ids(cypher: string): string[] {
    const result = ex.execute(cypher);
    if (!result.success) {
      throw new Error(`query failed: ${result.error.message}`);
    }
    return result.data.map((row) => row.id as string);
  }

  it('reaches an ancestor 15 levels up', () => {
    expect(
      ids(`MATCH (g:Group {depth: ${DEPTH}})
           WHERE (g)-[:IS_CHILD_OF*1..]->(:Group {depth: 0})
           RETURN g.id AS id`),
    ).toEqual([`G${DEPTH}`]);
  });

  it('satisfies a minimum hop count above the old cap', () => {
    expect(
      ids(`MATCH (g:Group {id: 'G11'})
           WHERE (g)-[:IS_CHILD_OF*11..]->(:Group)
           RETURN g.id AS id`),
    ).toEqual(['G11']);
  });

  it('still honours an explicit upper bound', () => {
    expect(
      ids(`MATCH (g:Group {depth: ${DEPTH}})
           WHERE (g)-[:IS_CHILD_OF*1..5]->(:Group {depth: 0})
           RETURN g.id AS id`),
    ).toEqual([]);
  });

  it('negation is correct beyond the old cap', () => {
    // G15 does reach depth 0, so NOT must exclude it
    expect(
      ids(`MATCH (g:Group {depth: ${DEPTH}})
           WHERE NOT (g)-[:IS_CHILD_OF*1..]->(:Group {depth: 0})
           RETURN g.id AS id`),
    ).toEqual([]);
  });

  it('terminates on a cycle rather than recursing forever', () => {
    expect(
      ids(`MATCH (c:Cyclic {id: 'C1'})
           WHERE (c)-[:LINKS_TO*1..]->(:Cyclic {id: 'C3'})
           RETURN c.id AS id`),
    ).toEqual(['C1']);
  });

  it('terminates on a cycle when the target is unreachable', () => {
    expect(
      ids(`MATCH (c:Cyclic {id: 'C1'})
           WHERE (c)-[:LINKS_TO*1..]->(:Cyclic {id: 'NOPE'})
           RETURN c.id AS id`),
    ).toEqual([]);
  });

  it('terminates on an undirected walk over a cycle', () => {
    expect(
      ids(`MATCH (c:Cyclic {id: 'C1'})
           WHERE (c)-[:LINKS_TO*1..]-(:Cyclic {id: 'C2'})
           RETURN c.id AS id`),
    ).toEqual(['C1']);
  });
});
