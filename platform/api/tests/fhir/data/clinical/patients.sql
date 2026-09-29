CREATE TABLE patients (
    patient_id VARCHAR(20) PRIMARY KEY,
    family_name VARCHAR(64) NOT NULL,
    given_name VARCHAR(64) NOT NULL,
    sex CHAR(1) NOT NULL CHECK (sex IN ('M', 'F')),
    birth_date DATE NOT NULL,
    phone VARCHAR(32)
);
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0001', 'TSAI', 'JACK', 'M', '1965-03-20', '+886-2-5550-0001');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0002', 'LIN', 'JACK', 'F', '1989-06-03', '+886-2-5550-0002');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0003', 'HALL', 'JIE', 'F', '1953-06-29', '+886-2-5550-0003');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0004', 'BROWN', 'HENRY', 'M', '1953-11-05', '+886-2-5550-0004');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0005', 'HSU', 'GRACE', 'M', '1945-08-06', '+886-2-5550-0005');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0006', 'SMITH', 'WEI', 'F', '1962-09-13', '+886-2-5550-0006');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0007', 'TAYLOR', 'DAVID', 'F', '1965-08-16', '+886-2-5550-0007');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0008', 'HSU', 'DAVID', 'M', '1951-07-22', '+886-2-5550-0008');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0009', 'WU', 'LING', 'M', '1988-04-23', '+886-2-5550-0009');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0010', 'WANG', 'BEN', 'F', '1991-12-30', '+886-2-5550-0010');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0011', 'WU', 'JIE', 'M', '1961-01-31', '+886-2-5550-0011');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0012', 'WANG', 'DAVID', 'M', '1997-05-28', '+886-2-5550-0012');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0013', 'CLARK', 'HAO', 'F', '1994-03-25', '+886-2-5550-0013');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0014', 'JONES', 'ANNA', 'F', '1985-02-21', '+886-2-5550-0014');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0015', 'CLARK', 'JUN', 'F', '1941-10-13', '+886-2-5550-0015');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0016', 'LEWIS', 'LING', 'M', '1966-07-09', '+886-2-5550-0016');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0017', 'CHENG', 'FRANK', 'M', '1970-04-06', '+886-2-5550-0017');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0018', 'HALL', 'MEI', 'F', '1985-02-11', '+886-2-5550-0018');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0019', 'CHENG', 'EMMA', 'F', '1968-10-21', '+886-2-5550-0019');
INSERT INTO patients (patient_id, family_name, given_name, sex, birth_date, phone) VALUES ('SYN-42-0020', 'CHANG', 'JIE', 'M', '1985-06-16', '+886-2-5550-0020');
