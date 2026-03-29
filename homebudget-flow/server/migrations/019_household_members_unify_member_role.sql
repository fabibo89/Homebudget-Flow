-- Alle Haushaltsmitglieder gleichberechtigt: historische owner-Rolle auf member setzen.
UPDATE household_members SET role = 'member' WHERE role = 'owner';
