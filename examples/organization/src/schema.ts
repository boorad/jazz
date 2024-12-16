import { Account, CoList, CoMap, co } from "jazz-tools";

export class Project extends CoMap {
  name = co.string;
}

export class ListOfProjects extends CoList.Of(co.ref(Project)) {}

export class Organization extends CoMap {
  name = co.string;
  projects = co.ref(ListOfProjects);
}

export class ListOfOrganizations extends CoList.Of(co.ref(Organization)) {}

export class JazzAccountRoot extends CoMap {
  organizations = co.ref(ListOfOrganizations);
}

export class JazzAccount extends Account {
  root = co.ref(JazzAccountRoot);

  async migrate(creationProps?: { name: string }) {
    super.migrate(creationProps);

    if (!this._refs.root) {
      const ownership = { owner: this };

      this.root = JazzAccountRoot.create(
        {
          organizations: ListOfOrganizations.create(
            [
              Organization.create(
                {
                  name: `Your projects`,
                  projects: ListOfProjects.create([], ownership),
                },
                ownership,
              ),
            ],
            ownership,
          ),
        },
        ownership,
      );
    }
  }
}
