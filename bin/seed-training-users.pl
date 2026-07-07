#!/usr/bin/perl

# Create (or remove) the per-attendee staff logins used by
# benchmarks/koha_training_browser.js when TRAINING_USER_PREFIX is set.
#
# Run this on the Koha server itself, inside the instance's environment:
#
#   koha-shell <instance> -c "perl seed-training-users.pl --count 75 --password 'S3cretTraining!'"
#
# or in koha-testing-docker:
#
#   ktd --shell --run "perl /path/to/seed-training-users.pl --count 75 --password 'S3cretTraining!'"
#
# The created users are named <prefix>1 .. <prefix>N (default prefix
# 'training') with permissions for circulation, catalog, patrons, and
# placing holds - what a training attendee needs, nothing more.
#
# Clean up afterwards with the same arguments plus --delete.

use Modern::Perl;
use Getopt::Long;

use Koha::Patrons;
use Koha::Libraries;
use Koha::Patron::Categories;

my $count    = 75;
my $prefix   = 'training';
my $password = '';
my $branchcode;
my $categorycode;
my $delete;

# circulate (2) + catalogue (4) + borrowers (16) + reserveforothers (64)
my $flags = 86;

GetOptions(
    'count=i'        => \$count,
    'prefix=s'       => \$prefix,
    'password=s'     => \$password,
    'branchcode=s'   => \$branchcode,
    'categorycode=s' => \$categorycode,
    'flags=i'        => \$flags,
    'delete'         => \$delete,
) or die "Usage: $0 --count 75 --password 'secret' [--prefix training] [--branchcode MAIN] [--categorycode S] [--flags 86] [--delete]\n";

if ($delete) {
    my $deleted = 0;
    for my $i ( 1 .. $count ) {
        my $patron = Koha::Patrons->find( { userid => "$prefix$i" } );
        next unless $patron;

        # Only remove accounts this script created
        next unless $patron->surname eq 'TrainingUser';

        $patron->delete;
        $deleted++;
    }
    say "Deleted $deleted training users";
    exit 0;
}

die "A --password is required to create training users\n" unless $password;

$branchcode   //= Koha::Libraries->search->next->branchcode;
$categorycode //= Koha::Patron::Categories->search->next->categorycode;

my $created = 0;
my $skipped = 0;
for my $i ( 1 .. $count ) {
    my $userid = "$prefix$i";

    if ( Koha::Patrons->find( { userid => $userid } ) ) {
        $skipped++;
        next;
    }

    my $patron = Koha::Patron->new(
        {
            surname      => 'TrainingUser',
            firstname    => "Attendee $i",
            cardnumber   => $userid,
            userid       => $userid,
            branchcode   => $branchcode,
            categorycode => $categorycode,
            flags        => $flags,
        }
    )->store;

    $patron->set_password( { password => $password, skip_validation => 1 } );
    $created++;
}

say "Created $created training users (${prefix}1..$prefix$count, branch $branchcode, category $categorycode, flags $flags); skipped $skipped that already existed";
