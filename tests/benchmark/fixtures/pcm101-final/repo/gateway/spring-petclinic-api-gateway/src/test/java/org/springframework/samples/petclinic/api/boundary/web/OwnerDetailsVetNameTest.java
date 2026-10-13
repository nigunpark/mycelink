package org.springframework.samples.petclinic.api.boundary.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest;
import org.springframework.cloud.circuitbreaker.resilience4j.ReactiveResilience4JAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.net.ConnectException;
import java.util.concurrent.atomic.AtomicReference;

@WebFluxTest(controllers = ApiGatewayController.class)
@Import({ReactiveResilience4JAutoConfiguration.class, CircuitBreakerConfiguration.class,
    OwnerDetailsVetNameTest.Stubs.class})
class OwnerDetailsVetNameTest {

    static final AtomicReference<String> VETS_MODE = new AtomicReference<>("ok");

    static final String OWNER = """
        {"id":1,"firstName":"G","lastName":"H","pets":[{"id":20,"name":"Garfield"},{"id":21,"name":"Odie"}]}""";
    static final String VISITS = """
        {"items":[{"id":300,"petId":20,"description":"a","vetId":2},
                  {"id":301,"petId":20,"description":"b"},
                  {"id":302,"petId":21,"description":"c","vetId":99}]}""";
    static final String VETS = """
        [{"id":1,"firstName":"James","lastName":"Carter","specialties":[]},
         {"id":2,"firstName":"Helen","lastName":"Leary","specialties":[]}]""";

    @TestConfiguration
    @ComponentScan("org.springframework.samples.petclinic.api.application")
    static class Stubs {
        @Bean
        WebClient.Builder webClientBuilder() {
            ExchangeFunction fn = req -> {
                String host = req.url().getHost();
                if (host.equals("customers-service")) return json(HttpStatus.OK, OWNER);
                if (host.equals("visits-service")) return json(HttpStatus.OK, VISITS);
                if (host.equals("vets-service")) {
                    return switch (VETS_MODE.get()) {
                        case "error" -> json(HttpStatus.INTERNAL_SERVER_ERROR, "{}");
                        case "down" -> Mono.error(new ConnectException("down"));
                        default -> json(HttpStatus.OK, VETS);
                    };
                }
                return Mono.error(new IllegalStateException(host));
            };
            return WebClient.builder().exchangeFunction(fn);
        }

        private static Mono<ClientResponse> json(HttpStatus s, String body) {
            return Mono.just(ClientResponse.create(s)
                .header("Content-Type", MediaType.APPLICATION_JSON_VALUE).body(body).build());
        }
    }

    @Autowired
    private WebTestClient client;

    @Test
    void visitsCarryVetIdAndVetName() {
        VETS_MODE.set("ok");
        client.get().uri("/api/gateway/owners/1").exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.pets[0].visits[0].vetId").isEqualTo(2)
            .jsonPath("$.pets[0].visits[0].vetName").isEqualTo("Helen Leary")
            .jsonPath("$.pets[0].visits[1].vetId").isEmpty()
            .jsonPath("$.pets[0].visits[1].vetName").isEmpty()
            .jsonPath("$.pets[1].visits[0].vetId").isEqualTo(99)
            .jsonPath("$.pets[1].visits[0].vetName").isEmpty();
    }

    @Test
    void vetNameIsNullWhenVetsServiceErrors() {
        for (String mode : new String[] {"error", "down"}) {
            VETS_MODE.set(mode);
            client.get().uri("/api/gateway/owners/1").exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.pets.length()").isEqualTo(2)
                .jsonPath("$.pets[0].visits.length()").isEqualTo(2)
                .jsonPath("$.pets[1].visits.length()").isEqualTo(1)
                .jsonPath("$.pets[0].visits[0].vetId").isEqualTo(2)
                .jsonPath("$.pets[0].visits[0].vetName").value(v -> org.junit.jupiter.api.Assertions.assertNull(v));
        }
        VETS_MODE.set("ok");
    }
}
