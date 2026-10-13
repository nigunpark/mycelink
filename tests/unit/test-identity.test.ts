/**
 * Runner-aware canonical test identity (evidence/test-identity.ts).
 *
 * PCM-101 final, normal arm: both Java producers ran a valid RED, GREEN and
 * full regression, yet settle refused every criterion with
 * CRITERION_TEST_UNKNOWN. A JUnit/Surefire result is named
 * `org.springframework....VisitVetTest#createWithVet...` (its class, `#`,
 * its method) while the source reader declares the bare method; the stale-RED
 * guard compared the two forms as strings, so no Java test could ever be
 * declared. A test is now identified by its normalised source path and a
 * runner-specific key — for JUnit the method, the package and class stripped
 * and kept as raw evidence — resolved against the declarations at the head:
 * a class that is not the file's, a path that is not the class's, an
 * overload or a nested method the report cannot tell apart, a name no method
 * carries, stays unknown. JS keeps its full suite/title semantics; any other
 * runner is exact.
 */
import { describe, expect, it } from 'vitest';
import {
  TEST_IDENTITY_VERSION,
  javaTestDeclarations,
  namesDeclaration,
  parseJUnitReference,
  reportedIdentity,
  resolveDeclaration,
  runnerOf,
  sameTest,
  testTitle,
} from '../../src/evidence/test-identity.js';

const VISITS = 'spring-petclinic-visits-service/src/test/java/org/springframework/samples/petclinic/visits/web/VisitVetTest.java';
const FQCN = 'org.springframework.samples.petclinic.visits.web.VisitVetTest';

/** The visits worker's test file at its submitted head, shape for shape (PCM-101 final). */
const VISIT_VET_TEST = `package org.springframework.samples.petclinic.visits.web;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class VisitVetTest {

    @Autowired
    MockMvc mvc;

    @Test
    void visitsTableHasNullableVetIdAndSeedVisitsHaveNoVet() {
        Integer nullable = jdbc.queryForObject(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'VISITS' "
                + "AND COLUMN_NAME = 'VET_ID' AND IS_NULLABLE = 'YES'", Integer.class);
        assertEquals(1, nullable);
    }

    @Test
    void createWithVetStoresAndReturnsIt() throws Exception {
        mvc.perform(post("/owners/1/pets/21/visits").content("{\\"description\\":\\"x\\",\\"vetId\\":3}"))
            .andExpect(status().isCreated());
    }

    @Test
    void createWithNonPositiveVetIsRejectedAndNotStored() throws Exception {
        for (int bad : new int[] {0, -1}) {
            mvc.perform(post("/owners/1/pets/23/visits").content("{\\"vetId\\":" + bad + "}"));
        }
    }
}
`;

/** A gateway-style test: a nested static configuration class, lambdas, a switch expression and text blocks beside the tests. */
const GATEWAY_TEST = `package org.springframework.samples.petclinic.api.boundary.web;

@WebFluxTest(controllers = ApiGatewayController.class)
@Import({ReactiveResilience4JAutoConfiguration.class, OwnerDetailsVetNameTest.Stubs.class})
class OwnerDetailsVetNameTest {

    static final String OWNER = """
        {"id":1,"pets":[{"id":20}]}""";

    @TestConfiguration
    static class Stubs {
        @Bean
        WebClient.Builder webClientBuilder() {
            ExchangeFunction fn = req -> {
                return switch (VETS_MODE.get()) {
                    case "error" -> json(HttpStatus.INTERNAL_SERVER_ERROR, "{}");
                    default -> json(HttpStatus.OK, VETS);
                };
            };
            return WebClient.builder().exchangeFunction(fn);
        }
    }

    @Test
    void visitsCarryVetIdAndVetName() {
        client.get().uri("/api/gateway/owners/1").exchange().expectStatus().isOk();
    }

    @Test
    void vetNameIsNullWhenVetsServiceErrors() {
        for (String mode : new String[] {"error", "down"}) {
            client.get().uri("/api/gateway/owners/1").exchange().expectStatus().isOk();
        }
    }
}
`;

const NESTED = 'clinic/src/test/java/org/example/OrderTest.java';
/** Two nested classes declaring the same method, one at the top level, an overload pair, a parameterized test and display names. */
const ORDER_TEST = `package org.example;

class OrderTest {

    @Test
    void placesAnOrder() { }

    @Nested
    class WhenEmpty {
        @Test
        void rejects() { }

        @Test
        void totalIsZero() { }
    }

    @Nested
    class WhenFull {
        @Test
        void rejects() { }
    }

    @Test
    void prices() { }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void prices(int quantity) { }

    @ParameterizedTest(name = "{index} => {0}")
    @CsvSource({"a, 1", "b, 2"})
    void discounts(String code, java.util.List<Integer> amounts) { }

    @DisplayName("ships the order once")
    @Test
    void shipsOnce() { }
}
`;

describe('runner of a test path', () => {
  it('JUnit for Java and Kotlin sources, JS for JS/TS, exact for every other runner', () => {
    expect(runnerOf(VISITS)).toBe('junit');
    expect(runnerOf('app/src/test/kotlin/org/x/FooTest.kt')).toBe('junit');
    expect(runnerOf('packages/cli/src/index.test.ts')).toBe('js');
    expect(runnerOf('test/a.test.mjs')).toBe('js');
    expect(runnerOf('tests/test_orders.py')).toBe('exact');
    expect(runnerOf('pkg/orders_test.go')).toBe('exact');
  });
});

describe('a JUnit reference', () => {
  it('strips the package and the class from `Class#method`, keeping each as raw evidence', () => {
    expect(parseJUnitReference(`${FQCN}#createWithVetStoresAndReturnsIt`)).toEqual({ pkg: 'org.springframework.samples.petclinic.visits.web', classes: ['VisitVetTest'], method: 'createWithVetStoresAndReturnsIt', params: null, suffix: '', name: 'createWithVetStoresAndReturnsIt' });
    expect(parseJUnitReference('VisitVetTest#createWithVet')).toMatchObject({ pkg: '', classes: ['VisitVetTest'], method: 'createWithVet' });
    expect(parseJUnitReference('createWithVet')).toMatchObject({ pkg: null, classes: [], method: 'createWithVet' });
  });

  it('reads nested classes, parameter lists and invocation suffixes', () => {
    expect(parseJUnitReference('org.example.OrderTest$WhenEmpty#rejects')).toMatchObject({ pkg: 'org.example', classes: ['OrderTest', 'WhenEmpty'], method: 'rejects', params: null, suffix: '' });
    expect(parseJUnitReference('org.example.OrderTest#prices(int)[2]')).toMatchObject({ method: 'prices', params: ['int'], suffix: '[2]' });
    expect(parseJUnitReference('org.example.OrderTest#discounts(String, List)[1] a, 1')).toMatchObject({ method: 'discounts', params: ['String', 'List'], suffix: '[1] a, 1' });
    expect(parseJUnitReference('org.example.OrderTest#prices[0]')).toMatchObject({ method: 'prices', params: null, suffix: '[0]' });
    expect(parseJUnitReference('org.example.OrderTest#prices()')).toMatchObject({ method: 'prices', params: [] });
  });

  it('a display name is no method: kept as the name, resolved only through a declaration', () => {
    expect(parseJUnitReference('org.example.OrderTest#ships the order once')).toMatchObject({ classes: ['OrderTest'], method: null, name: 'ships the order once' });
    expect(parseJUnitReference('org.example.OrderTest#[1] 1')).toMatchObject({ method: null, name: '[1] 1' });
  });

  it('a malformed `#` is no reference at all', () => {
    for (const bad of ['#rejects', 'org.example.OrderTest#', 'org.example.OrderTest##rejects', 'org..OrderTest#rejects', 'org.example.#rejects', '1Order#rejects', 'Order Test#rejects', 'a#b#c']) {
      expect(parseJUnitReference(bad), bad).toBeNull();
    }
  });
});

describe('a reported identity', () => {
  it('JUnit: the source path and the method, package and class stripped; JS: the full suite/title name; other runners: exact', () => {
    expect(reportedIdentity({ path: VISITS, full_name: `${FQCN}#createWithVetStoresAndReturnsIt`, name: 'createWithVetStoresAndReturnsIt' })).toEqual({ version: TEST_IDENTITY_VERSION, runner: 'junit', path: VISITS, key: 'createWithVetStoresAndReturnsIt', classes: ['VisitVetTest'] });
    expect(reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#prices(int)[1]', name: 'prices(int)[1]' })).toEqual({ version: TEST_IDENTITY_VERSION, runner: 'junit', path: NESTED, key: 'prices', classes: ['OrderTest'], params: ['int'] });
    expect(reportedIdentity({ path: 'packages/cli/src/index.test.ts', full_name: 'status > prints every invalid changeset once', name: 'prints every invalid changeset once' })).toEqual({ version: TEST_IDENTITY_VERSION, runner: 'js', path: 'packages/cli/src/index.test.ts', key: 'status > prints every invalid changeset once' });
    expect(reportedIdentity({ path: 'tests/test_orders.py', full_name: 'TestOrders#test_places', name: 'test_places' })).toEqual({ version: TEST_IDENTITY_VERSION, runner: 'exact', path: 'tests/test_orders.py', key: 'TestOrders#test_places' });
    // A malformed JUnit name, or a display name, has no identity of its own: only a declaration can give it one.
    expect(reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest##prices' })).toBeNull();
    expect(reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#ships the order once' })).toBeNull();
  });

  it('the same test is the same identity whatever the class spelling; another file, class or overload is not', () => {
    const a = reportedIdentity({ path: VISITS, full_name: `${FQCN}#createWithVet` })!;
    expect(sameTest(a, reportedIdentity({ path: VISITS, full_name: 'createWithVet' })!)).toBe(true);
    expect(sameTest(a, reportedIdentity({ path: VISITS, full_name: 'VisitVetTest#createWithVet' })!)).toBe(true);
    expect(sameTest(a, reportedIdentity({ path: VISITS.replace('visits-service', 'api-gateway'), full_name: `${FQCN}#createWithVet` })!)).toBe(false);
    expect(sameTest(a, reportedIdentity({ path: VISITS, full_name: `${FQCN}#createWithoutVet` })!)).toBe(false);
    const empty = reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest$WhenEmpty#rejects' })!;
    expect(sameTest(empty, reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest$WhenFull#rejects' })!)).toBe(false);
    expect(sameTest(reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#prices(int)[1]' })!, reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#prices(int)[2]' })!)).toBe(true);
    expect(sameTest(reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#prices(int)[1]' })!, reportedIdentity({ path: NESTED, full_name: 'org.example.OrderTest#prices()' })!)).toBe(false);
  });
});

describe('Java test declarations', () => {
  it('each test method with its class chain, parameter types and display name', () => {
    expect(javaTestDeclarations(ORDER_TEST).map((d) => [d.classes.join('.'), d.name, d.params, d.display])).toEqual([
      ['OrderTest', 'placesAnOrder', [], null],
      ['OrderTest.WhenEmpty', 'rejects', [], null],
      ['OrderTest.WhenEmpty', 'totalIsZero', [], null],
      ['OrderTest.WhenFull', 'rejects', [], null],
      ['OrderTest', 'prices', [], null],
      ['OrderTest', 'prices', ['int'], null],
      ['OrderTest', 'discounts', ['String', 'List'], null],
      ['OrderTest', 'shipsOnce', [], 'ships the order once'],
    ]);
  });

  it('a nested configuration class, lambdas, switch expressions and text blocks do not move a test out of its class', () => {
    expect(javaTestDeclarations(GATEWAY_TEST).map((d) => [d.classes.join('.'), d.name])).toEqual([
      ['OwnerDetailsVetNameTest', 'visitsCarryVetIdAndVetName'],
      ['OwnerDetailsVetNameTest', 'vetNameIsNullWhenVetsServiceErrors'],
    ]);
  });
});

describe('a reported test resolved against its file at the head', () => {
  const resolve = (full: string, source: string | null = ORDER_TEST, path = NESTED, extra: { name?: string; classname?: string } = {}) => resolveDeclaration({ path, full_name: full, ...extra }, source);

  it('PCM-101: the class-qualified Surefire name is the method the file declares', () => {
    for (const m of ['visitsTableHasNullableVetIdAndSeedVisitsHaveNoVet', 'createWithVetStoresAndReturnsIt', 'createWithNonPositiveVetIsRejectedAndNotStored']) {
      const r = resolveDeclaration({ path: VISITS, full_name: `${FQCN}#${m}`, name: m }, VISIT_VET_TEST);
      expect(r, m).toMatchObject({ status: 'declared', translated: true, identity: { version: TEST_IDENTITY_VERSION, runner: 'junit', path: VISITS, key: m, classes: ['VisitVetTest'] } });
    }
    const gateway = 'spring-petclinic-api-gateway/src/test/java/org/springframework/samples/petclinic/api/boundary/web/OwnerDetailsVetNameTest.java';
    expect(resolveDeclaration({ path: gateway, full_name: 'org.springframework.samples.petclinic.api.boundary.web.OwnerDetailsVetNameTest#visitsCarryVetIdAndVetName' }, GATEWAY_TEST)).toMatchObject({ status: 'declared', identity: { key: 'visitsCarryVetIdAndVetName' } });
    // The raw class is kept as evidence: the bare method resolves the same declaration, untranslated.
    expect(resolveDeclaration({ path: VISITS, full_name: 'createWithVetStoresAndReturnsIt' }, VISIT_VET_TEST)).toMatchObject({ status: 'declared', translated: false, identity: { key: 'createWithVetStoresAndReturnsIt' } });
  });

  it('the same method name in two nested classes: the report\'s class tells them apart, a bare name or the outer class cannot', () => {
    expect(resolve('org.example.OrderTest$WhenEmpty#rejects')).toMatchObject({ status: 'declared', identity: { key: 'rejects', classes: ['OrderTest', 'WhenEmpty'] } });
    expect(resolve('org.example.OrderTest$WhenFull#rejects')).toMatchObject({ status: 'declared', identity: { key: 'rejects', classes: ['OrderTest', 'WhenFull'] } });
    expect(resolve('org.example.OrderTest#rejects')).toMatchObject({ status: 'ambiguous' });
    expect(resolve('rejects')).toMatchObject({ status: 'ambiguous' });
    // A method only one nested class declares is unambiguous from the outer class too.
    expect(resolve('org.example.OrderTest#totalIsZero')).toMatchObject({ status: 'declared', identity: { key: 'totalIsZero', classes: ['OrderTest', 'WhenEmpty'] } });
  });

  it('an overload is told apart only by the parameters the report names; a bare name is ambiguous', () => {
    expect(resolve('org.example.OrderTest#prices(int)[1]')).toMatchObject({ status: 'declared', identity: { key: 'prices', params: ['int'] } });
    expect(resolve('org.example.OrderTest#prices()')).toMatchObject({ status: 'declared', identity: { key: 'prices', params: [] } });
    expect(resolve('org.example.OrderTest#prices')).toMatchObject({ status: 'ambiguous' });
    expect(resolve('org.example.OrderTest#prices(String)[1]')).toMatchObject({ status: 'missing' });
  });

  it('parameterized invocations and display names', () => {
    expect(resolve('org.example.OrderTest#discounts(String, List)[2] b, 2')).toMatchObject({ status: 'declared', identity: { key: 'discounts' } });
    expect(resolve('org.example.OrderTest#discounts[1]')).toMatchObject({ status: 'declared', identity: { key: 'discounts' } });
    expect(resolve('org.example.OrderTest#ships the order once')).toMatchObject({ status: 'declared', translated: true, identity: { key: 'shipsOnce' } });
    // An invocation display no declaration names: unknown, never guessed.
    expect(resolve('org.example.OrderTest#[1] 1')).toMatchObject({ status: 'missing' });
  });

  it('a class the file does not declare, or a path that is not its class\'s, is refused', () => {
    expect(resolve('org.example.FakeTest#placesAnOrder')).toMatchObject({ status: 'mismatch' });
    expect(resolve('org.example.OrderTest$Fake#placesAnOrder')).toMatchObject({ status: 'mismatch' });
    expect(resolve('org.other.OrderTest#placesAnOrder')).toMatchObject({ status: 'mismatch' });
    // The same class and method in another module's file: resolved only against that file, never this one.
    expect(resolve('org.example.OrderTest#placesAnOrder', ORDER_TEST, 'other/src/test/java/org/example/OrderTest.java')).toMatchObject({ status: 'declared', identity: { path: 'other/src/test/java/org/example/OrderTest.java' } });
    expect(resolveDeclaration({ path: VISITS, full_name: 'org.example.OrderTest#placesAnOrder' }, VISIT_VET_TEST)).toMatchObject({ status: 'mismatch' });
  });

  it('a renamed, deleted or never-committed test, a malformed name and an absent file are not declared', () => {
    expect(resolve('org.example.OrderTest#placesAnOrderTwice')).toMatchObject({ status: 'missing' });
    expect(resolve('org.example.OrderTest#placesAnOrder', ORDER_TEST.replace('void placesAnOrder()', 'void placesOrders()'))).toMatchObject({ status: 'missing' });
    expect(resolve('org.example.OrderTest#placesAnOrder', null)).toMatchObject({ status: 'missing' });
    expect(resolve('org.example.OrderTest##placesAnOrder')).toMatchObject({ status: 'mismatch' });
    expect(resolve('#placesAnOrder')).toMatchObject({ status: 'mismatch' });
  });

  it('a method without @Test is no test', () => {
    expect(resolve('org.example.OrderTest#helper', `${ORDER_TEST.slice(0, -2)}\n    void helper() { }\n}\n`)).toMatchObject({ status: 'missing' });
  });

  it('JS keeps its full suite/title semantics: a title ending in a method string is not a JUnit method, and no suffix is stripped', () => {
    const js = `import { describe, it } from 'vitest';\ndescribe('VisitVetTest', () => {\n  it('handles VisitVetTest#createWithVet', () => {});\n  it('createWithVet', () => {});\n});\n`;
    const path = 'web/src/visits.test.ts';
    expect(resolveDeclaration({ path, full_name: 'VisitVetTest > handles VisitVetTest#createWithVet' }, js)).toMatchObject({ status: 'declared', translated: false, identity: { runner: 'js', key: 'VisitVetTest > handles VisitVetTest#createWithVet' } });
    expect(resolveDeclaration({ path, full_name: 'VisitVetTest > createWithVet' }, js)).toMatchObject({ status: 'declared', identity: { key: 'VisitVetTest > createWithVet' } });
    expect(resolveDeclaration({ path, full_name: `${FQCN}#createWithVet` }, js)).toMatchObject({ status: 'missing' });
    expect(resolveDeclaration({ path, full_name: 'createWithVetStoresAndReturnsIt' }, js)).toMatchObject({ status: 'missing' });
    // A table-driven title cannot be told from the file.
    expect(resolveDeclaration({ path, full_name: 'adds 1 + 1' }, `it.each([[1, 1]])('adds %i + %i', () => {});\n`)).toMatchObject({ status: 'unreadable' });
  });

  it('other runners are exact: a JUnit-looking name is never stripped', () => {
    const py = 'def test_places():\n    assert True\n';
    expect(resolveDeclaration({ path: 'tests/test_orders.py', full_name: 'test_places' }, py)).toMatchObject({ status: 'declared', identity: { runner: 'exact' } });
    expect(resolveDeclaration({ path: 'tests/test_orders.py', full_name: 'TestOrders#test_places' }, py)).toMatchObject({ status: 'missing' });
    expect(resolveDeclaration({ path: 'tests/orders.rb', full_name: 'places' }, 'it "places" do end\n')).toMatchObject({ status: 'unreadable' });
  });
});

describe('a declaration-level title and name', () => {
  it('JUnit: the method; JS: the last suite segment; exact: the name', () => {
    expect(testTitle(VISITS, `${FQCN}#createWithVet`)).toBe('createWithVet');
    expect(testTitle(NESTED, 'org.example.OrderTest#prices(int)[1]')).toBe('prices');
    expect(testTitle('packages/cli/src/index.test.ts', 'status > prints once')).toBe('prints once');
    expect(testTitle('tests/test_orders.py', 'TestOrders#test_places')).toBe('TestOrders#test_places');
    expect(namesDeclaration(VISITS, `${FQCN}#createWithVet`, 'createWithVet')).toBe(true);
    expect(namesDeclaration(VISITS, `${FQCN}#createWithVet`, 'createWithVetStoresAndReturnsIt')).toBe(false);
    expect(namesDeclaration('packages/cli/src/index.test.ts', 'status > prints once', 'prints once')).toBe(true);
    expect(namesDeclaration('packages/cli/src/index.test.ts', 'prints once', 'prints once')).toBe(true);
    expect(namesDeclaration('packages/cli/src/index.test.ts', 'org.x.A#prints once', 'prints once')).toBe(false);
  });
});
