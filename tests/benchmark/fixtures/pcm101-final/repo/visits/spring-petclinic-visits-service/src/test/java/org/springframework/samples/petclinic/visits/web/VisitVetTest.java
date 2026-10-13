package org.springframework.samples.petclinic.visits.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.nullValue;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class VisitVetTest {

    @Autowired
    MockMvc mvc;

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void visitsTableHasNullableVetIdAndSeedVisitsHaveNoVet() {
        Integer nullable = jdbc.queryForObject(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'VISITS' "
                + "AND COLUMN_NAME = 'VET_ID' AND IS_NULLABLE = 'YES'", Integer.class);
        assertEquals(1, nullable);
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM visits WHERE vet_id IS NOT NULL", Integer.class));
    }

    @Test
    void createWithVetStoresAndReturnsIt() throws Exception {
        mvc.perform(post("/owners/1/pets/21/visits").contentType(MediaType.APPLICATION_JSON)
                .content("{\"description\":\"x\",\"vetId\":3}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.vetId").value(3));
        mvc.perform(get("/owners/1/pets/21/visits"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].vetId").value(3));
        mvc.perform(get("/pets/visits?petId=21"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].vetId").value(3));
    }

    @Test
    void createWithoutVetHasNullVet() throws Exception {
        mvc.perform(post("/owners/1/pets/22/visits").contentType(MediaType.APPLICATION_JSON)
                .content("{\"description\":\"x\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.vetId").value(nullValue()))
            .andExpect(jsonPath("$.description").value("x"));
        mvc.perform(post("/owners/1/pets/22/visits").contentType(MediaType.APPLICATION_JSON)
                .content("{\"description\":\"y\",\"vetId\":null}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.vetId").value(nullValue()));
        mvc.perform(get("/owners/1/pets/22/visits"))
            .andExpect(jsonPath("$[0].vetId").value(nullValue()));
    }

    @Test
    void createWithNonPositiveVetIsRejectedAndNotStored() throws Exception {
        for (int bad : new int[] {0, -1}) {
            mvc.perform(post("/owners/1/pets/23/visits").contentType(MediaType.APPLICATION_JSON)
                    .content("{\"description\":\"x\",\"vetId\":" + bad + "}"))
                .andExpect(status().isBadRequest());
        }
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM visits WHERE pet_id = 23", Integer.class));
    }

    @Test
    void vetVisitsOrderedByDateThenId() throws Exception {
        jdbc.update("INSERT INTO visits (pet_id, visit_date, description, vet_id) VALUES (31, '2020-02-02', 'b', 77)");
        jdbc.update("INSERT INTO visits (pet_id, visit_date, description, vet_id) VALUES (32, '2020-01-01', 'a', 77)");
        jdbc.update("INSERT INTO visits (pet_id, visit_date, description, vet_id) VALUES (33, '2020-02-02', 'c', 77)");
        jdbc.update("INSERT INTO visits (pet_id, visit_date, description, vet_id) VALUES (34, '2020-01-01', 'o', 78)");
        mvc.perform(get("/vets/77/visits"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.length()").value(3))
            .andExpect(jsonPath("$[0].description").value("a"))
            .andExpect(jsonPath("$[1].description").value("b"))
            .andExpect(jsonPath("$[2].description").value("c"))
            .andExpect(jsonPath("$[0].vetId").value(77));
    }

    @Test
    void vetWithoutVisitsGetsEmptyArray() throws Exception {
        mvc.perform(get("/vets/9999/visits"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.length()").value(0));
    }
}
